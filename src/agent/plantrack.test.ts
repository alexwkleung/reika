import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import {
  applyCommand,
  applyEdit,
  buildPlanProgressLedger,
  decidePlanGate,
  MAX_PLAN_GATE_ROUNDS,
  parsePlanSteps,
  seedPlanProgress,
  waiveUnchecked,
} from './plantrack.js';

const PLAN = [
  'Here is the plan.',
  '',
  '1. Add `parseThing` to `src/agent/thing.ts` with unit tests',
  '   - also update src/agent/index.ts',
  '2) Wire the parser into `src/agent/loop.ts`',
  'Step 3: Update the README with the new flag',
  '4. Run the test suite and verify',
].join('\n');

describe('parsePlanSteps', () => {
  it('parses 1. / 2) / Step 3: forms and attaches sub-bullet paths to the owning step', () => {
    const steps = parsePlanSteps(PLAN);
    expect(steps.map(s => s.n)).toEqual([1, 2, 3, 4]);
    expect(steps[0].paths).toEqual(['src/agent/thing.ts', 'src/agent/index.ts']);
    expect(steps[1].paths).toEqual(['src/agent/loop.ts']);
    expect(steps[3].paths).toEqual([]);
    expect(steps.every(s => !s.done)).toBe(true);
  });

  it('ignores numbering and paths inside fenced code blocks', () => {
    const steps = parsePlanSteps(
      ['1. Edit `a.ts`', '```', '2. not a step', 'src/fake/path.ts', '```', '2. Edit `b.ts`'].join(
        '\n',
      ),
    );
    expect(steps.map(s => s.n)).toEqual([1, 2]);
    expect(steps[0].paths).toEqual(['a.ts']);
  });

  it('ignores indented sub-numbering and returns [] for prose with no steps', () => {
    expect(parsePlanSteps('1. Top\n     1. nested sub-item\n').map(s => s.n)).toEqual([1]);
    expect(parsePlanSteps('No numbered steps here, just prose.')).toEqual([]);
  });

  it('keeps slashless file names with known extensions but not backticked property access', () => {
    const steps = parsePlanSteps('1. Change `config.ts`, `theme.accent`, and `opts.config`');
    expect(steps[0].paths).toEqual(['config.ts']);
  });

  it('strips ./ prefixes, :line suffixes, and bold markers', () => {
    const steps = parsePlanSteps('1. **Fix** `./src/a.ts:120` now');
    expect(steps[0].text).toBe('Fix `./src/a.ts:120` now');
    expect(steps[0].paths).toEqual(['src/a.ts']);
  });

  it('parses heading- and bold-styled step lines', () => {
    const steps = parsePlanSteps(
      ['## Step 1: Tighten spacing', '**Step 2: Verify**', '**3.** Ship it'].join('\n'),
    );
    expect(steps.map(s => s.text)).toEqual(['Tighten spacing', 'Verify', 'Ship it']);
    expect(steps.map(s => s.n)).toEqual([1, 2, 3]);
  });

  it('promotes command bullets to steps instead of attaching them to the last numbered step', () => {
    // The observed shape: one numbered step, then a "Test checks at end:" section as an unordered
    // list. The command bullets must become their own checkable steps — merged into step 1 they
    // would (a) never show as work items and (b) mis-check step 1 when a test command runs.
    const steps = parsePlanSteps(
      [
        '1. `packages/ui/src/styles.css` — Change `margin-bottom` from `3px` to `1px`.',
        '',
        'Test checks at end:',
        '',
        '- `npm run typecheck --workspaces --if-present`',
        '- `npm test -w @kana/server -w @kana/ui`',
        '- `npm run lint`',
      ].join('\n'),
    );
    expect(steps.map(s => s.n)).toEqual([1, 2, 3, 4]);
    expect(steps[0].paths).toEqual(['packages/ui/src/styles.css']);
    expect(steps[0].commands).toEqual([]);
    expect(steps[1].commands).toEqual(['npm run typecheck --workspaces --if-present']);
    expect(steps[3].commands).toEqual(['npm run lint']);
    // Running a test command checks its own step off, not the CSS step.
    expect(applyCommand(steps, 'npm run lint')).toBe(3);
    expect(steps[0].done).toBe(false);
  });

  it('keeps plain bullets as step detail, not steps', () => {
    const steps = parsePlanSteps(
      '1. Do the change in `src/a.ts`\n- also update `src/b.ts`\n- preserves visual separation',
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('treats top-level bullets as the plan when no numbered steps exist', () => {
    const steps = parsePlanSteps(
      ['- Edit `src/config.ts` to add the flag', '- Run `npm test` to verify'].join('\n'),
    );
    expect(steps.map(s => s.n)).toEqual([1, 2]);
    expect(steps[0].paths).toEqual(['src/config.ts']);
    expect(steps[1].commands).toEqual(['npm test']);
  });

  it('renumbers ordinally when sections restart the written numbering', () => {
    // The observed failure shape: a heading-styled work step plus a "Verification" section whose
    // ordered list restarts at 1. All of it tracks, with unique step numbers — the work step must
    // not vanish while the verification list becomes the whole plan.
    const steps = parsePlanSteps(
      [
        '## Step 1: Tighten workspace item spacing',
        'File: `packages/ui/src/styles.css`, line 262',
        '',
        '### Verification',
        '1. Run `npm run typecheck --workspaces --if-present` to confirm nothing breaks.',
        '2. Run `npm test -w @kana/ui` to confirm the build passes.',
        '3. Visual check: open the dropdown and confirm items are tighter.',
      ].join('\n'),
    );
    expect(steps.map(s => s.n)).toEqual([1, 2, 3, 4]);
    expect(steps[0].paths).toEqual(['packages/ui/src/styles.css']);
    expect(steps[1].commands).toEqual(['npm run typecheck --workspaces --if-present']);
    expect(steps[2].commands).toEqual(['npm test -w @kana/ui']);
    // The visual check has no observable signal — display-only, never gated.
    expect(steps[3].paths).toEqual([]);
    expect(steps[3].commands).toEqual([]);
  });
});

describe('applyEdit', () => {
  it('matches on segment-boundary suffix in either direction', () => {
    const steps = parsePlanSteps('1. Edit `config.ts`\n2. Edit `reika/src/ui/App.tsx`');
    expect(applyEdit(steps, 'src/config.ts')).toEqual({ index: 0, by: 'path' });
    expect(applyEdit(steps, 'src/ui/App.tsx')).toEqual({ index: 1, by: 'path' });
  });

  it('does not match a bare basename against a different file', () => {
    const steps = parsePlanSteps('1. Edit `myconfig.ts`');
    expect(applyEdit(steps, 'src/config.ts')).toBeNull();
  });

  it('checks the earliest pending step when two steps name the same file', () => {
    const steps = parsePlanSteps('1. Edit `src/loop.ts`\n2. Also touch `src/loop.ts`');
    expect(applyEdit(steps, 'src/loop.ts')?.index).toBe(0);
    expect(applyEdit(steps, 'src/loop.ts')?.index).toBe(1);
    expect(applyEdit(steps, 'src/loop.ts')).toBeNull();
  });

  it('falls back to content match when the plan names the wrong file', () => {
    // The observed failure: the plan pins a CSS change to the component file, the model correctly
    // edits styles.css. The step's quoted snippet appearing in the diff checks it off anyway.
    const steps = parsePlanSteps(
      '1. In `src/components/WorkspaceSelect.tsx`, change `margin-bottom: 3px` to `margin-bottom: 2px`',
    );
    const diff = ['-   margin-bottom: 3px;', '+   margin-bottom: 2px;'].join('\n');
    expect(applyEdit(steps, 'src/styles.css', diff)).toEqual({ index: 0, by: 'content' });
    expect(steps[0].done).toBe(true);
  });

  it('prefers a path match on any step over a content match', () => {
    const steps = parsePlanSteps(
      '1. Change `margin-bottom: 3px` in `a.css`\n2. Update `src/b.css`',
    );
    const diff = '- margin-bottom: 3px;';
    expect(applyEdit(steps, 'src/b.css', diff)).toEqual({ index: 1, by: 'path' });
  });

  it('never content-matches on bare identifiers or short spans', () => {
    const steps = parsePlanSteps('1. Update `parsePlanSteps` and `foo()` in `missing.ts`');
    expect(steps[0].snippets).toEqual([]);
    expect(applyEdit(steps, 'src/other.ts', 'import { parsePlanSteps } from x')).toBeNull();
  });
});

describe('applyCommand', () => {
  it('checks a command step off when a successful run contains it, wrapper prefixes included', () => {
    const steps = parsePlanSteps(
      '1. Run `npm run typecheck --workspaces --if-present && npm run lint`\n2. Run `npm test -w @kana/ui`',
    );
    expect(steps[0].commands).toHaveLength(1);
    expect(
      applyCommand(
        steps,
        'cd ~/Git/kana && npm run typecheck --workspaces --if-present && npm run lint',
      ),
    ).toBe(0);
    expect(applyCommand(steps, 'npm test -w @kana/ui')).toBe(1);
    expect(applyCommand(steps, 'npm test -w @kana/ui')).toBe(-1);
  });

  it('does not treat prose or paths as commands', () => {
    const steps = parsePlanSteps('1. Edit `src/config.ts` and mention `npm` somewhere');
    expect(steps[0].commands).toEqual([]);
  });
});

describe('waiveUnchecked', () => {
  it('waives only pending enforceable steps and reports their numbers', () => {
    const steps = parsePlanSteps(
      '1. Edit `src/a.ts`\n2. Run `npm test -w x`\n3. Verify the result manually',
    );
    applyEdit(steps, 'src/a.ts');
    expect(waiveUnchecked(steps)).toEqual([2]);
    expect(steps.map(s => s.waived)).toEqual([false, true, false]);
    // Idempotent: already-waived steps are not re-reported.
    expect(waiveUnchecked(steps)).toEqual([]);
  });
});

const plan = (content: string): Message => ({ role: 'assistant', content, planFinal: true });
const edited = (path: string): Message => ({
  role: 'tool',
  callId: 'c1',
  summary: `Edited ${path} at line 3 (+1 -1)`,
  diff: { text: '', path, added: 1, removed: 1 },
});

describe('seedPlanProgress', () => {
  it('returns null without a plan or when the plan has no numbered steps', () => {
    expect(seedPlanProgress([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(seedPlanProgress([plan('just prose, no steps')])).toBeNull();
  });

  it('replays successful edits after the plan, preferring diff paths', () => {
    const steps = seedPlanProgress([
      { role: 'user', content: 'do the thing' },
      plan(PLAN),
      { role: 'user', content: 'execute the plan above' },
      edited('src/agent/thing.ts'),
      { role: 'tool', callId: 'c2', summary: 'Wrote src/agent/loop.ts (+10)' },
      { role: 'tool', callId: 'c3', summary: 'Edit failed for README.md' },
    ]);
    expect(steps?.map(s => s.done)).toEqual([true, true, false, false]);
  });

  it('anchors on the most recent plan and ignores edits before it', () => {
    const steps = seedPlanProgress([
      plan('1. Edit `old.ts`'),
      edited('src/agent/loop.ts'),
      plan(PLAN),
    ]);
    expect(steps?.every(s => !s.done)).toBe(true);
    expect(steps).toHaveLength(4);
  });

  it('replays content matches, successful bash runs, and gate waivers', () => {
    const steps = seedPlanProgress([
      plan(
        '1. Change `margin-bottom: 3px` in `src/Wrong.tsx`\n' +
          '2. Run `npm test -w @kana/ui`\n' +
          '3. Edit `src/never-touched.ts`',
      ),
      {
        role: 'tool',
        callId: 'c1',
        summary: 'Edited src/styles.css at line 261 (+1 -1)',
        diff: {
          text: '-  margin-bottom: 3px;\n+  margin-bottom: 2px;',
          path: 'src/styles.css',
          added: 1,
          removed: 1,
        },
      },
      {
        role: 'tool',
        callId: 'c2',
        summary: 'Ran: cd /x && npm test -w @kana/ui (100 bytes output)',
        command: { text: 'cd /x && npm test -w @kana/ui', outputTail: '', outputTruncated: false },
      },
      // A failed run must not check anything off.
      {
        role: 'tool',
        callId: 'c3',
        summary: 'Bash failed: npm test (exit 1)',
        command: { text: 'npm test', outputTail: '', outputTruncated: false },
      },
      {
        role: 'system',
        content: 'Plan gate: step 3 not observed done after retry — waived.',
        planWaived: [3],
      },
    ]);
    expect(steps?.map(s => s.done)).toEqual([true, true, false]);
    expect(steps?.map(s => s.waived)).toEqual([false, false, true]);
  });
});

describe('buildPlanProgressLedger', () => {
  it('marks done and pending steps and instructs plan-order work', () => {
    const steps = parsePlanSteps(PLAN);
    applyEdit(steps, 'src/agent/thing.ts');
    const ledger = buildPlanProgressLedger(steps);
    expect(ledger).toContain('[x] 1.');
    expect(ledger).toContain('[ ] 2.');
    expect(ledger).toContain('not user input');
    expect(ledger).toContain('plan order');
  });
});

describe('decidePlanGate', () => {
  it('passes when every file-bearing step is done, even with pathless steps pending', () => {
    const steps = parsePlanSteps(PLAN);
    for (const p of ['src/agent/thing.ts', 'src/agent/loop.ts']) applyEdit(steps, p);
    // Steps 3 and 4 name no file path ("the README", "run the tests") — never gated on.
    expect(steps[2].done).toBe(false);
    expect(steps[3].done).toBe(false);
    expect(decidePlanGate({ steps, gateRounds: 0, maxRounds: MAX_PLAN_GATE_ROUNDS })).toEqual({
      action: 'pass',
    });
  });

  it('retries once with the unfinished steps quoted, then waives with a notice', () => {
    const steps = parsePlanSteps(PLAN);
    applyEdit(steps, 'src/agent/thing.ts');
    const first = decidePlanGate({ steps, gateRounds: 0, maxRounds: MAX_PLAN_GATE_ROUNDS });
    expect(first.action).toBe('retry');
    expect(first.modelMessage).toContain('[ ] 2.');
    expect(first.userNotice).toContain('step 2 unchecked');
    const second = decidePlanGate({ steps, gateRounds: 1, maxRounds: MAX_PLAN_GATE_ROUNDS });
    expect(second.action).toBe('waive');
    expect(second.userNotice).toContain('waived');
  });

  it('never re-asks a waived step on later turns', () => {
    const steps = parsePlanSteps('1. Edit `src/never.ts`');
    waiveUnchecked(steps);
    expect(decidePlanGate({ steps, gateRounds: 0, maxRounds: MAX_PLAN_GATE_ROUNDS })).toEqual({
      action: 'pass',
    });
  });
});
