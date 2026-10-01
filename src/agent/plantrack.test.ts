import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import {
  applyCommand,
  applyEdit,
  buildPlanProgressLedger,
  decidePlanGate,
  MAX_PLAN_GATE_ROUNDS,
  latestPlanMarker,
  planChanged,
  parsePlanSteps,
  refineTarget,
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

  it('extracts bare absolute paths and matches them against relative edit paths', () => {
    // The observed shape: a plan naming files by absolute path with no backticks
    // ("Modify renderRow function in /home/user/projects/app/web/src/scripts/rows.ts:").
    // Unextracted, the step carries no path signal and the (relative-path) edit never checks it.
    const steps = parsePlanSteps(
      [
        '1. Modify renderRow function in /home/user/projects/app/web/src/scripts/rows.ts:',
        '2. Add CSS styles in `/home/user/projects/app/web/src/styles/global.css` (or existing stylesheet)',
      ].join('\n'),
    );
    expect(steps[0].paths).toEqual(['/home/user/projects/app/web/src/scripts/rows.ts']);
    expect(steps[1].paths).toEqual(['/home/user/projects/app/web/src/styles/global.css']);
    expect(applyEdit(steps, 'web/src/scripts/rows.ts')).toEqual({ index: 0, by: 'path' });
    expect(applyEdit(steps, 'web/src/styles/global.css')).toEqual({ index: 1, by: 'path' });
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

  it('parses dash-delimited step headings and bare command lines', () => {
    // The observed shape: bold "Step N — Title" headings (no ./):( delimiter), detail bullets, and
    // an unmarked command block. Without the dash form no steps parse at all, so bullet-only mode
    // promoted the detail bullets as the whole plan and the commands were invisible.
    const steps = parsePlanSteps(
      [
        "Here's the plan:",
        '',
        '**Step 1 — Tighten workspace dropdown item gap**',
        '',
        '- File: `packages/ui/src/styles.css`, line 262',
        '- Change `margin-bottom: 3px` → `margin-bottom: 1px`',
        '',
        '**Step 2 — Run the standard routine**',
        '',
        'npm run typecheck --workspaces --if-present',
        'npm run lint',
        'npm test -w @kana/server -w @kana/ui',
        '',
        '(No test changes needed — this is a pure CSS tweak.)',
      ].join('\n'),
    );
    expect(steps.map(s => s.text)).toEqual([
      'Tighten workspace dropdown item gap',
      'Run the standard routine',
    ]);
    expect(steps[0].paths).toEqual(['packages/ui/src/styles.css']);
    expect(steps[0].snippets).toContain('margin-bottom: 3px');
    expect(steps[0].commands).toEqual([]);
    expect(steps[1].commands).toEqual([
      'npm run typecheck --workspaces --if-present',
      'npm run lint',
      'npm test -w @kana/server -w @kana/ui',
    ]);
  });

  it('accepts em/en dash and hyphen step delimiters but only with the Step keyword', () => {
    expect(parsePlanSteps('## Step 1 – Do the thing')[0].text).toBe('Do the thing');
    expect(parsePlanSteps('Step 1 - Do the thing')[0].text).toBe('Do the thing');
    // A bare "1 — option" line is prose comparison shape, not a step.
    expect(parsePlanSteps('1 — cheap option\n2 — fast option')).toEqual([]);
  });

  it('extracts commands from shell-ish fences but never from tagged code fences', () => {
    const steps = parsePlanSteps(
      [
        '1. Add the worker to `src/util.ts`',
        '```go',
        'go func() {',
        '```',
        '2. Run the checks',
        '```',
        '$ npm run lint',
        'npm test -w @kana/ui',
        '```',
      ].join('\n'),
    );
    expect(steps).toHaveLength(2);
    expect(steps[0].commands).toEqual([]);
    expect(steps[1].commands).toEqual(['npm run lint', 'npm test -w @kana/ui']);
  });

  it('never extracts commands from prose starting with English runner words', () => {
    const steps = parsePlanSteps(
      '1. Update `src/a.ts`\ngo to the settings page and verify\nmake sure the tests pass',
    );
    expect(steps[0].commands).toEqual([]);
  });

  it('never extracts non-terminating commands, so human verify-steps stay unenforced', () => {
    // The observed shape: a "verify visually" step quoting `npm run dev`. A dev server never exits,
    // so extracting it would make the step gate-enforceable but forever unchecked — guaranteed
    // bounce-then-waive noise on a step only a human can do.
    const steps = parsePlanSteps(
      [
        '1. Tighten workspace dropdown gap (`packages/ui/src/styles.css`):',
        '2. Run typecheck + lint:',
        'npm run typecheck --workspaces --if-present',
        'npm run lint',
        '3. Run UI tests:',
        'npm test -w @kana/ui',
        '4. Verify visually in dev server:',
        'npm run dev -w @kana/web',
      ].join('\n'),
    );
    expect(steps).toHaveLength(4);
    expect(steps[1].commands).toEqual([
      'npm run typecheck --workspaces --if-present',
      'npm run lint',
    ]);
    expect(steps[2].commands).toEqual(['npm test -w @kana/ui']);
    expect(steps[3].commands).toEqual([]);
  });

  it('excludes watch/serve shapes in backticked and bullet contexts too', () => {
    const steps = parsePlanSteps('1. Run `npm test --watch` while iterating\n- npm run serve');
    expect(steps).toHaveLength(1);
    expect(steps[0].commands).toEqual([]);
    expect(steps[0].snippets).toEqual([]);
  });

  it('promotes bare-command bullets like backticked ones', () => {
    const steps = parsePlanSteps('1. Edit `src/a.ts`\n- npm run lint');
    expect(steps).toHaveLength(2);
    expect(steps[1].commands).toEqual(['npm run lint']);
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
        exitCode: 0,
      },
      // A red run must not check anything off. Since #200 it reports as `Ran:` like any other
      // command, so the exit code is the only thing separating it from the green run above.
      {
        role: 'tool',
        callId: 'c3',
        summary: 'Ran: npm test (exit 1, 4120 bytes output)',
        command: { text: 'npm test', outputTail: '', outputTruncated: false },
        exitCode: 1,
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

// #200 backward compatibility. seedPlanProgress re-derives progress by replaying history from the
// plan forward — it never accumulates — so a tool message without the new `exitCode` field must keep
// reading as it did before, or a resumed session or loaded transcript would silently un-check steps
// that were checked off moments earlier, days after the change that caused it.
describe('seedPlanProgress — results predating exitCode', () => {
  const PLAN_CMD = '1. Run `npm test`\n2. Edit `src/never-touched.ts`';
  const ran = (summary: string, exitCode?: number | null): Message => ({
    role: 'tool',
    callId: 'c1',
    summary,
    command: { text: 'npm test', outputTail: '', outputTruncated: false },
    ...(exitCode !== undefined ? { exitCode } : {}),
  });

  it('falls back to the Ran: prefix when no exit status rode along', () => {
    const steps = seedPlanProgress([plan(PLAN_CMD), ran('Ran: npm test (100 bytes output)')]);
    expect(steps?.map(s => s.done)).toEqual([true, false]);
  });

  it('still ignores an old-style failure line with no exit status', () => {
    const steps = seedPlanProgress([plan(PLAN_CMD), ran('Bash failed: npm test (exit 1)')]);
    expect(steps?.map(s => s.done)).toEqual([false, false]);
  });

  it('treats a signal death as a known status, not a missing one', () => {
    // exitCode null would be indistinguishable from absent under a `?? ` fallback, and the summary
    // it carries starts with `Ran: ` — so the prefix reading would check the step off.
    const steps = seedPlanProgress([
      plan(PLAN_CMD),
      ran('Ran: npm test (killed by SIGKILL, 12 bytes output)', null),
    ]);
    expect(steps?.map(s => s.done)).toEqual([false, false]);
  });

  it('does not check off a non-bash result that happens to carry exit 0', () => {
    // ranSuccessfully answers "did it end green", not "was this a command" — callers scope to bash
    // (or to a result carrying a command) themselves.
    const steps = seedPlanProgress([
      plan(PLAN_CMD),
      { role: 'tool', callId: 'r1', summary: 'Read src/a.ts (40 lines)', exitCode: 0 },
    ]);
    expect(steps?.map(s => s.done)).toEqual([false, false]);
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

  it('frames a tick as evidence, never as a finished step', () => {
    // The tick lands on the FIRST edit to a file the step names, so a single-file step that needs
    // many edits is ticked while the model is still inside it. The ledger must not let that read as
    // licence to move on — the model obeys its own checklist.
    const steps = parsePlanSteps(PLAN);
    applyEdit(steps, 'src/agent/thing.ts');
    const ledger = buildPlanProgressLedger(steps);
    expect(ledger).toContain('has seen evidence');
    expect(ledger).toContain('not proof the step is finished');
    expect(ledger).toContain('finish the step you are on');
    expect(ledger).toContain("Don't redo work you have already finished");
    expect(ledger).not.toContain('Do not re-do checked steps');
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

// #46. The plan a plan-mode turn refines: the newest written plan, with no other kind of model turn
// after it. Both halves matter — a step-less marker is a dead-ended plan turn (#126), and a plan with a
// model turn after it belongs to an earlier exchange (vibe runs its implementation off the same
// prompt, so that is what a later vibe prompt looks like).
describe('latestPlanMarker / refineTarget', () => {
  it('takes the newest plan marker and parses its steps', () => {
    const marker = latestPlanMarker([
      plan('1. Edit `old.ts`'),
      { role: 'user', content: 'revise it' },
      plan(PLAN),
    ]);
    expect(marker?.index).toBe(2);
    expect(marker?.steps).toHaveLength(4);
    expect(latestPlanMarker([{ role: 'user', content: 'hi' }])).toBeNull();
  });

  // The grounding/URL notes are appended to the plan message at commit; a refinement handed them as
  // its own plan text would copy a stale advisory into the revision.
  it('stops at the appended plan-check notes', () => {
    const body = '1. Edit `src/config.ts`';
    const withNotes = {
      ...plan(body + '\n\n--- reika: plan grounding check (auto-generated) ---\n- `src/config.ts`'),
      planChecks: { at: body.length, missing: ['src/config.ts'], deadUrls: [] },
    };
    const marker = latestPlanMarker([withNotes]);
    expect(marker?.content).toBe(body);
    expect(marker?.steps).toHaveLength(1);
  });

  it('keeps a step-less marker visible to latestPlanMarker but not as a refinement target', () => {
    const marker = latestPlanMarker([plan('1. Edit `a.ts`'), plan('I could not determine that.')]);
    expect(marker?.steps).toEqual([]);
    expect(refineTarget([plan('1. Edit `a.ts`'), plan('I could not determine that.')])).toBeNull();
  });

  it('is a refinement target only while no other kind of turn followed the plan', () => {
    const planned: Message[] = [plan(PLAN)];
    expect(refineTarget(planned)?.content).toBe(PLAN);
    // The follow-up prompt itself is a user message, so it doesn't disqualify.
    expect(refineTarget([...planned, { role: 'user', content: 'also do X' }])).not.toBeNull();
    // Another model turn after the plan does. The turn in progress is not the one after the plan.
    expect(
      refineTarget([
        ...planned,
        { role: 'user', content: 'implement the plan above' },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'now do Y' },
      ]),
    ).toBeNull();
  });
});

// #46 review. A plan-mode follow-up that wrote no new plan — aborted, spiral-stopped, or answered in
// prose — changed nothing the plan is about, so the plan stays live across it. Any other turn in
// between (an implementation, or a turn with no plan-mode stamp) still retires it.
describe('the plan stays live across plan-mode turns that wrote no new plan', () => {
  const followUp = (content: string): Message => ({ role: 'user', content, mode: 'plan' });

  it('refines after an aborted or spiral-stopped follow-up', () => {
    for (const stop of ['(aborted)', "I couldn't converge — the reasoning kept looping."]) {
      const history: Message[] = [
        plan(PLAN),
        followUp('also cover X'),
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
        { role: 'assistant', content: stop },
        followUp('also cover X, but only the settings screen'),
      ];
      expect(refineTarget(history)?.content).toBe(PLAN);
    }
  });

  it('looks past a prose answer to a follow-up question', () => {
    const history: Message[] = [
      { role: 'user', content: 'add dark mode' },
      plan(PLAN),
      followUp('why is step 3 needed?'),
      plan('Because the palette is read at startup.'),
    ];
    expect(latestPlanMarker(history)?.content).toBe(PLAN);
    expect(seedPlanProgress(history)).toHaveLength(4);
    expect(refineTarget([...history, followUp('ok, drop step 3')])?.content).toBe(PLAN);
  });

  it('does not look past a step-less plan that followed another kind of turn', () => {
    const history: Message[] = [
      plan(PLAN),
      { role: 'user', content: 'implement it', mode: 'agent' },
      { role: 'assistant', content: 'Done.' },
      followUp('now plan the export feature'),
      plan('I could not determine which file handles export.'),
    ];
    expect(latestPlanMarker(history)?.steps).toEqual([]);
    expect(seedPlanProgress(history)).toBeNull();
    expect(refineTarget([...history, followUp('try again')])).toBeNull();
    // A turn with no stamp at all is not a plan-mode turn either.
    expect(
      refineTarget([
        plan(PLAN),
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ]),
    ).toBeNull();
  });
});

// #46. Whether a refinement round actually landed: compared on the parsed steps, since a model that
// re-emits the plan it already had will renumber or re-head it freely.
describe('planChanged', () => {
  it('reads a renumbering or reformat of the same steps as unchanged', () => {
    expect(
      planChanged('1. Edit `a.ts`\n2. Run `npm test`', '1) Edit `a.ts`\n2) Run `npm test`'),
    ).toBe(false);
    expect(planChanged('1. Edit `a.ts`', 'Here is the plan.\n\n**Step 1:** Edit `a.ts`')).toBe(
      false,
    );
  });

  it('reads a changed step, a changed count, or a step-less reply as changed', () => {
    expect(planChanged('1. Edit `a.ts`', '1. Edit `b.ts`')).toBe(true);
    expect(planChanged('1. Edit `a.ts`', '1. Edit `a.ts`\n2. Run `npm test`')).toBe(true);
    expect(planChanged('1. Edit `a.ts`', 'I could not determine that.')).toBe(true);
  });
});

// A follow-up question answered with a numbered list parsed as steps and took over as the live plan:
// /implement then checked off the explanation. An answer names no files or commands, which is what
// separates it from a question-phrased request that produced a real plan.
describe('a numbered answer to a follow-up question is not a plan', () => {
  const followUp = (content: string): Message => ({ role: 'user', content, mode: 'plan' });
  const answer = plan('1. The palette is read at startup.\n2. The toggle reads the palette.');

  it('keeps the plan above live', () => {
    const history: Message[] = [
      { role: 'user', content: 'add dark mode', mode: 'plan' },
      plan(PLAN),
      followUp('why this order?'),
      answer,
    ];
    expect(latestPlanMarker(history)?.content).toBe(PLAN);
    expect(seedPlanProgress(history)).toHaveLength(4);
    expect(refineTarget([...history, followUp('ok, swap steps 1 and 2')])?.content).toBe(PLAN);
  });

  it('still takes a file-specific plan written for a question-phrased request', () => {
    const newPlan = '1. Edit `src/export.ts` to stream rows';
    const history: Message[] = [
      plan(PLAN),
      followUp('how should we fix the export bug instead?'),
      plan(newPlan),
    ];
    expect(latestPlanMarker(history)?.content).toBe(newPlan);
  });

  it('takes a numbered answer when there is no plan above it', () => {
    const history: Message[] = [followUp('how does the palette load?'), answer];
    expect(latestPlanMarker(history)?.steps).toHaveLength(2);
  });
});
