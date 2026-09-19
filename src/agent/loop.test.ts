import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import {
  flagRepeatedCall,
  type RepeatEntry,
  buildAgentLoopLedger,
  buildWithdrawalDirective,
  withdrawalRemedy,
  withdrawnToolsPhrase,
  buildAbsentGrounding,
  buildEditRecoveryLedger,
  buildPlanWritePrompt,
  buildConvergeSteer,
  buildSteadySystem,
  shouldWithdrawInspection,
  buildPlanTransformInput,
} from './loop.js';

// The three tool lists the withdrawal text has to speak to: agent (everything), minimal mode's
// bash-only (#391), and chat (neither an editor nor a shell).
const AGENT_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'list',
  'grep',
  'glob',
  'edit',
  'write',
  'bash',
]);
const MINIMAL_TOOLS: ReadonlySet<string> = new Set(['bash']);
const CHAT_TOOLS: ReadonlySet<string> = new Set(['fetch_url', 'search']);

// Convenience: read calls keyed on path+offset.
const read = (
  seen: Map<string, RepeatEntry>,
  args: Record<string, unknown>,
  summary: string,
  payload: string | undefined = 'body',
) => flagRepeatedCall(seen, 'read', args, summary, payload);

describe('flagRepeatedCall', () => {
  it('leaves the first call untouched', () => {
    const seen = new Map<string, RepeatEntry>();
    expect(read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800')).toBe('body');
  });

  it('flags a same-or-wider re-read from the same offset, but not a narrowing one', () => {
    const seen = new Map<string, RepeatEntry>();
    // All start at line 1. Widening (100 -> 300) is a repeat: the model already had those bytes.
    read(seen, { path: 'a.ts', limit: 100 }, 'Read a.ts lines 1-100 of 800');
    const wider = read(seen, { path: 'a.ts', limit: 300 }, 'Read a.ts lines 1-300 of 800');
    expect(wider).toContain('2 times');
    expect(wider?.startsWith('body')).toBe(true);
    // Narrowing (300 -> 80) is the move the omission marker asks for when the earlier copy was
    // capped — it returns bytes the model has NOT seen, so it restarts the run rather than
    // counting toward it. Observed: read(1-300) capped, read(1-150) capped again AND nudged
    // "won't make progress", and the model spun on the contradiction.
    const narrower = read(seen, { path: 'a.ts', limit: 80 }, 'Read a.ts lines 1-80 of 800');
    expect(narrower).toBe('body');
    // Repeating the narrow window IS the loop, and is caught on its second step.
    const again = read(seen, { path: 'a.ts', limit: 80 }, 'Read a.ts lines 1-80 of 800');
    expect(again).toContain('2 times');
  });

  it('treats a default-window read followed by an explicit narrower one as narrowing', () => {
    // The observed shape: read(path) with no limit is READ_DEFAULT_LIMIT lines, and the follow-up
    // names a smaller window explicitly. Resolved as the tool resolves it, not as absent-vs-present.
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'src/tools/bash.ts' }, 'Read src/tools/bash.ts lines 1-300 of 329');
    const narrower = read(
      seen,
      { path: 'src/tools/bash.ts', offset: 1, limit: 150 },
      'Read src/tools/bash.ts lines 1-150 of 329',
    );
    expect(narrower).toBe('body');
  });

  it('stops exempting narrowing after a bounded number of descents', () => {
    // A model shrinking 300 -> 200 -> 100 -> 50 -> 25 -> ... forever is spinning too. Same bound as
    // readtrace.ts (MAX_NARROWINGS = 3), so the metric and the nudge name the same read as the loop.
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'a.ts', limit: 300 }, 'Read a.ts lines 1-300 of 800');
    expect(read(seen, { path: 'a.ts', limit: 200 }, 'Read a.ts lines 1-200 of 800')).toBe('body');
    expect(read(seen, { path: 'a.ts', limit: 100 }, 'Read a.ts lines 1-100 of 800')).toBe('body');
    expect(read(seen, { path: 'a.ts', limit: 50 }, 'Read a.ts lines 1-50 of 800')).toBe('body');
    expect(read(seen, { path: 'a.ts', limit: 25 }, 'Read a.ts lines 1-25 of 800')).toContain(
      '2 times',
    );
  });

  it('names the remedy that works when the flagged copy was itself capped', () => {
    // "Identical bytes" was only true when the earlier copy shipped whole; under the fit-to-window
    // cap the same read can arrive gutted twice. The nudge must not tell the model the one move
    // that works (a read small enough to arrive whole) is pointless.
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'a.ts', limit: 150 }, 'Read a.ts lines 1-150 of 329');
    const second = read(seen, { path: 'a.ts', limit: 150 }, 'Read a.ts lines 1-150 of 329');
    expect(second).toContain('same window returns the same bytes');
    expect(second).toContain('read a range small enough to arrive whole');
    expect(second).not.toContain('identical bytes');
  });

  it('names the exact range in the read nudge (concrete redirect, not generic)', () => {
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    const second = read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    // Points at the specific range via the summary, and keeps the escalating count.
    expect(second).toContain('Read a.ts lines 1-200 of 800');
    expect(second).toContain('2 times');
    expect(second).toContain(
      're-reading the same start line with the same window returns the same bytes',
    );
    expect(second?.startsWith('body')).toBe(true);
  });

  it('does not flag genuine forward paging (different offsets)', () => {
    const seen = new Map<string, RepeatEntry>();
    const a = read(seen, { path: 'a.ts', offset: 1 }, 'Read a.ts lines 1-200 of 800', 'b1');
    const b = read(seen, { path: 'a.ts', offset: 200 }, 'Read a.ts lines 200-399 of 800', 'b2');
    const c = read(seen, { path: 'a.ts', offset: 400 }, 'Read a.ts lines 400-599 of 800', 'b3');
    expect(a).toBe('b1');
    expect(b).toBe('b2');
    expect(c).toBe('b3');
  });

  it('tracks bash repeats keyed on summary (incl. byte count)', () => {
    const seen = new Map<string, RepeatEntry>();
    const s = 'Ran: grep -n blendAlbums src/server/index.ts (140 bytes output)';
    flagRepeatedCall(seen, 'bash', { command: 'grep -n blendAlbums src/server/index.ts' }, s, 'o');
    const again = flagRepeatedCall(
      seen,
      'bash',
      { command: 'grep -n blendAlbums src/server/index.ts' },
      s,
      'o',
    );
    expect(again).toContain('2 times');
  });

  it('does not flag bash when output size differs (changed/flaky command)', () => {
    const seen = new Map<string, RepeatEntry>();
    flagRepeatedCall(
      seen,
      'bash',
      { command: 'npm test' },
      'Ran: npm test (1200 bytes output)',
      'o',
    );
    const again = flagRepeatedCall(
      seen,
      'bash',
      { command: 'npm test' },
      'Ran: npm test (1500 bytes output)',
      'o',
    );
    expect(again).toBe('o'); // different byte count -> different summary -> not a repeat
  });

  it('bash does NOT clear read-tracking (interspersed grep -n must not reset it)', () => {
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'a.ts', limit: 100 }, 'Read a.ts lines 1-100 of 800');
    flagRepeatedCall(
      seen,
      'bash',
      { command: 'grep -n x a.ts' },
      'Ran: grep -n x a.ts (10 bytes output)',
      'o',
    );
    const second = read(seen, { path: 'a.ts', limit: 300 }, 'Read a.ts lines 1-300 of 800');
    expect(second).toContain('2 times'); // read memory survived the bash call
  });

  it('edit/write resets memory so a later identical read is not flagged', () => {
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    flagRepeatedCall(seen, 'edit', { path: 'a.ts' }, 'Edited a.ts', undefined);
    const after = read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    expect(after).toBe('body');
  });

  it('passes untracked tools (fetch/search) through without flagging or clearing', () => {
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    const fetched = flagRepeatedCall(seen, 'fetch_url', { url: 'x' }, 'Fetched x', 'page');
    expect(fetched).toBe('page');
    // read memory not cleared by the untracked tool:
    const second = read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    expect(second).toContain('2 times');
  });

  it('escalates the grep count across identical-pattern repeats', () => {
    const seen = new Map<string, RepeatEntry>();
    const s = 'Found 0 matches for /discover/';
    flagRepeatedCall(seen, 'grep', { pattern: 'discover' }, s, '');
    flagRepeatedCall(seen, 'grep', { pattern: 'discover' }, s, '');
    expect(flagRepeatedCall(seen, 'grep', { pattern: 'discover' }, s, '')).toContain('3 times');
  });

  it('handles an undefined payload on a repeat without crashing', () => {
    const seen = new Map<string, RepeatEntry>();
    read(seen, { path: 'a.ts', offset: 999 }, 'Read a.ts: offset 999 past end of file', undefined);
    const out = read(
      seen,
      { path: 'a.ts', offset: 999 },
      'Read a.ts: offset 999 past end of file',
      undefined,
    );
    expect(out).toMatch(/2 times/);
  });
});

describe('buildAgentLoopLedger', () => {
  it('names the looping files and gives a stop-or-explain directive', () => {
    const ledger = buildAgentLoopLedger(
      [
        { path: 'packages/ui/src/api/sse.ts', offset: 1, repeats: 3 },
        { path: 'packages/server/src/http/chat.ts', offset: 201, repeats: 3 },
      ],
      false,
      AGENT_TOOLS,
    );
    // Names both files (the one past line 1 carries its offset), persists the "already read" fact,
    // and offers the non-edit escape so a cornered model isn't forced into a wrong change.
    expect(ledger).toContain('packages/ui/src/api/sse.ts');
    expect(ledger).toContain('packages/server/src/http/chat.ts:L201');
    expect(ledger).toContain('identical bytes');
    expect(ledger).toContain('state specifically what is still blocking you');
  });

  it('escalates to a hard pause directive once inspection tools are withdrawn', () => {
    const looping = [{ path: 'packages/server/src/http/chat.ts', offset: 151, repeats: 3 }];
    const soft = buildAgentLoopLedger(looping, false, AGENT_TOOLS);
    const hard = buildAgentLoopLedger(looping, true, AGENT_TOOLS);
    // Soft tier: still frames re-reading as unhelpful. Hard tier: states reading is paused.
    expect(soft).toContain('Re-reading them returns identical bytes');
    expect(soft).not.toContain('PAUSED');
    expect(hard).toContain('PAUSED');
    expect(hard).toContain('Make the edit');
    // Both name the looping file and keep the blocker escape.
    expect(hard).toContain('chat.ts:L151');
    expect(hard).toContain('what is still blocking you');
  });

  it('caps the listed files so a pathological turn cannot bloat the system prompt', () => {
    const many = Array.from({ length: 20 }, (_, n) => ({
      path: `f${n}.ts`,
      offset: 1,
      repeats: 3,
    }));
    const ledger = buildAgentLoopLedger(many, false, AGENT_TOOLS);
    expect(ledger).toContain('f0.ts');
    expect(ledger).toContain('f7.ts');
    expect(ledger).not.toContain('f8.ts'); // sliced at 8
  });

  it('adds a "complete → say so and stop" out to the withdrawn directive (post-edit loops)', () => {
    const hard = buildAgentLoopLedger([{ path: 'a.ts', offset: 1, repeats: 3 }], true, AGENT_TOOLS);
    expect(hard).toContain('if the change is already complete');
  });

  it('falls back to a generic message for a reasoning loop with no tight read repeat', () => {
    // The agent-mode reasoning-loop arm passes an empty `looping` (each read paged a fresh region /
    // the same grep kept returning 0 matches, so ReadTrace saw no repeat). The ledger must still fire
    // a stop directive without naming any file, and keep the blocker escape for the can't-find case.
    const soft = buildAgentLoopLedger([], false, AGENT_TOOLS);
    expect(soft).toContain('repeated the same reasoning and searches');
    expect(soft).not.toContain('identical bytes'); // file-specific phrasing suppressed
    expect(soft).toContain('a symbol your searches');
    expect(soft).not.toContain('PAUSED');

    const hard = buildAgentLoopLedger([], true, AGENT_TOOLS);
    expect(hard).toContain('repeated the same reasoning and searches');
    expect(hard).toContain('PAUSED');
    expect(hard).toContain('Make the edit');
  });

  it('names a remedy the turn actually has when there are no edit tools', () => {
    // #391: in a bash-only mode "make the edit with the edit/write tools" is a pointer at two tools
    // the model cannot see, and a model told to reach for an absent tool reaches for nothing.
    // Flattened: the hand-wrapping is presentation, the content is the invariant.
    const hard = buildAgentLoopLedger([], true, MINIMAL_TOOLS).replace(/\n/g, ' ');
    expect(hard).toContain('PAUSED');
    expect(hard).not.toContain('edit/write');
    expect(hard).toContain('running the command that applies it');
    // The escapes that need no tool at all survive in every mode.
    expect(hard).toContain('state specifically what is still blocking you');
    expect(hard).toContain('if the change is already complete');
  });
});

describe('withdrawal text follows the turn tool list', () => {
  it('names only the inspection surface the mode actually has', () => {
    expect(withdrawnToolsPhrase(AGENT_TOOLS)).toBe(
      'inspection tools (read/grep/glob/list, and read-only shell commands like grep/cat/tail)',
    );
    // Minimal mode has no read/grep/glob/list to pause, so it must not claim to have paused them.
    expect(withdrawnToolsPhrase(MINIMAL_TOOLS)).toBe(
      'read-only shell commands (grep/cat/tail and similar inspection)',
    );
    // Plan mode's default list is the other way round: the named tools, no shell.
    expect(withdrawnToolsPhrase(new Set(['read', 'grep', 'glob', 'list']))).toBe(
      'inspection tools (read/grep/glob/list)',
    );
  });

  it('picks the remedy from the tools on offer', () => {
    expect(withdrawalRemedy(AGENT_TOOLS)).toContain('edit/write tools');
    expect(withdrawalRemedy(MINIMAL_TOOLS)).toContain('running the command that applies it');
    // Neither an editor nor a shell: the remedy has to be one that needs no tool.
    expect(withdrawalRemedy(CHAT_TOOLS)).toBe('Answer from what you already have');
  });

  it('leaves agent mode byte-identical to the pre-list-aware text', () => {
    // House rule: a change that only adds a new mode must not move the bytes of the existing one,
    // or every measurement taken against the old text silently stops comparing.
    expect(buildWithdrawalDirective(AGENT_TOOLS)).toBe(
      '(reika: inspection tools (read/grep/glob/list, and read-only shell commands like grep/cat/tail) ' +
        'are paused because you have repeated the same reads or searches without making progress. You ' +
        'already have what you need. Make the edit the task requires with the edit/write tools, state ' +
        'what is specifically blocking you, or — if the change is already complete — say so and stop. ' +
        'Reading and searching are unavailable until you make progress.)',
    );
    expect(buildAgentLoopLedger([], true, AGENT_TOOLS)).toContain(
      'Reading and searching are now PAUSED. Make the edit the task requires with the edit/write\n' +
        'tools, state specifically what is still blocking you, or — if the change is already complete —\n' +
        'say so and stop.',
    );
  });

  it('builds a directive that points at nothing absent', () => {
    const agent = buildWithdrawalDirective(AGENT_TOOLS);
    expect(agent).toContain('read/grep/glob/list');
    expect(agent).toContain('edit/write tools');

    const minimal = buildWithdrawalDirective(MINIMAL_TOOLS);
    // The whole point: no phantom tool names anywhere in the sentence.
    for (const absent of ['read/grep/glob/list', 'edit/write', 'glob', 'list']) {
      expect(minimal).not.toContain(absent);
    }
    expect(minimal).toContain('read-only shell commands (grep/cat/tail and similar inspection)');
    expect(minimal).toContain('running the command that applies it');
    // Still says what it is and how to get out of it.
    expect(minimal).toContain('are paused because you have repeated the same reads or searches');
    expect(minimal).toContain('say so and stop');
  });
});

describe('buildEditRecoveryLedger', () => {
  it('quotes the exact divergence and embeds the verbatim excerpt', () => {
    const ledger = buildEditRecoveryLedger({
      kind: 'diverged',
      path: 'src/a.css',
      divergentLine: 3,
      expected: 'color: blue;',
      actual: 'color: red;',
      excerpt: '    2│  font-size: 13px;\n    3│  color: red;',
    });
    expect(ledger).toContain('src/a.css');
    expect(ledger).toContain('line 3');
    expect(ledger).toContain('"color: blue;"'); // what the model expected
    expect(ledger).toContain('"color: red;"'); // what the file actually has
    expect(ledger).toContain('3│  color: red;'); // verbatim copyable bytes
    expect(ledger).toContain('character-for-character'); // the single instruction
    // Offers the honest out so a cornered model stops instead of retrying a wrong anchor.
    expect(ledger).toContain('stop');
  });

  it('returns empty for an absent failure (buildAbsentGrounding owns that path)', () => {
    expect(buildEditRecoveryLedger({ kind: 'absent', path: 'src/a.css' })).toBe('');
  });
});

describe('buildAbsentGrounding', () => {
  it('hands over the located region verbatim and forbids retrying from memory', () => {
    const g = buildAbsentGrounding({
      kind: 'absent',
      path: 'src/ui/App.tsx',
      at: 132,
      excerpt: '  132│  const [modelSelect, setModelSelect] = useState(null);',
    });
    expect(g).toContain('NOT applied');
    expect(g).toContain('src/ui/App.tsx');
    expect(g).toContain('not in your context'); // names the real cause
    expect(g).toContain('line 132');
    expect(g).toContain('132│  const [modelSelect'); // copyable bytes
    expect(g).toContain('character-for-character');
    // Forecloses the rationalization this failure reliably produces, which is what turns a
    // one-round correction into a spiral.
    expect(g).toMatch(/formatter/i);
  });

  it('says so plainly when no region could be located', () => {
    const g = buildAbsentGrounding({ kind: 'absent', path: 'src/ui/App.tsx' });
    expect(g).toContain('no region to show');
    expect(g).toContain('read src/ui/App.tsx');
    // No invented location, and no excerpt gutter.
    expect(g).not.toMatch(/line \d/);
    expect(g).not.toContain('│');
  });
});

describe('buildPlanWritePrompt', () => {
  it('omits the steer by default (normal force-write)', () => {
    const p = buildPlanWritePrompt();
    expect(p).toContain('PLAN MODE');
    expect(p).not.toMatch(/overcomplicate|re-questioning|second-guess/i);
  });

  it('appends the converge-retry steer when asked, on top of the base prompt', () => {
    const p = buildPlanWritePrompt(true);
    expect(p).toContain('PLAN MODE'); // base instruction still present
    expect(p).toMatch(/overcomplicate/i); // the proven phrasing
    expect(p).toMatch(/looped and kept re-questioning/i);
    expect(p).toMatch(/commit to one analysis/i);
  });
});

describe('buildConvergeSteer', () => {
  it('names the self-questioning spiral and pushes the model to commit and act', () => {
    const s = buildConvergeSteer();
    expect(s).toContain('--- reika status'); // a status directive, not user input
    expect(s).toMatch(/overcomplicate/i);
    expect(s).toMatch(/commit to one concrete action/i);
    expect(s).toMatch(/make the edit|final answer/i); // the two acceptable exits
    expect(s).toMatch(/second-guess|re-question/i); // names the failure mode
  });
});

describe('buildSteadySystem', () => {
  const explored: Message[] = [
    { role: 'user', content: 'do the thing' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'read a.ts' },
  ];

  it('agent mode with no plan steps is the bare base prompt', () => {
    expect(
      buildSteadySystem({
        baseSystem: 'BASE',
        promptMode: 'agent',
        history: explored,
        round: 0,
        planSteps: null,
      }),
    ).toBe('BASE');
  });

  it('plan mode appends the exploration ledger with round-driven escalation', () => {
    const at = (round: number): string =>
      buildSteadySystem({
        baseSystem: 'BASE',
        promptMode: 'plan',
        history: explored,
        round,
        planSteps: null,
      });
    expect(at(0)).toContain('Files examined: a.ts');
    expect(at(0)).not.toContain('STOP. Call no more tools.');
    expect(at(3)).toMatch(/explored across 3 rounds/);
    expect(at(6)).toContain('STOP. Call no more tools.');
    // The ledger is a system suffix on top of the base prompt.
    expect(at(0).startsWith('BASE\n\n')).toBe(true);
  });

  it('emits the dropped-payload notice in the default config (#227, on since 2026-09-18)', () => {
    // This file sets no flags, so it is the honest default-config check. The four compositions
    // live in loop.droppedpayload*.test.ts; the `=0` no-op guard in loop.droppedpayload.off.test.ts.
    // c1 is the pinned spec (#228) and c3 is the live trailing block, so c2 is the one that was
    // actually dropped — without it the notice has nothing to fire on, on either arm.
    const dropped: Message[] = [
      ...explored.slice(0, 2),
      { role: 'tool', callId: 'c1', summary: 'Ran: gh (505 bytes output)', payload: 'ISSUE' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c2', summary: 'Read b.ts', payload: 'BODY' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c3', summary: 'Read c.ts', payload: 'FRESH' },
    ];
    for (const promptMode of ['agent', 'plan'] as const) {
      const s = buildSteadySystem({
        baseSystem: 'BASE',
        promptMode,
        history: dropped,
        round: 0,
        planSteps: null,
      });
      expect(s).toContain('dropped to make room');
    }
  });

  it('plan mode with nothing explored nudges toward a first tool call', () => {
    const s = buildSteadySystem({
      baseSystem: 'BASE',
      promptMode: 'plan',
      history: [{ role: 'user', content: 'plan it' }],
      round: 0,
      planSteps: null,
    });
    expect(s).toContain('Nothing examined yet');
  });
});

describe('shouldWithdrawInspection', () => {
  const base = { editRecovery: false };

  it('does not withdraw before the loop has persisted LOOP_WITHDRAW_AFTER rounds', () => {
    expect(shouldWithdrawInspection({ ...base, loopActiveRounds: 1 })).toBe(false);
  });

  it('withdraws a pre-edit read loop (the original explore→act case)', () => {
    expect(shouldWithdrawInspection({ ...base, loopActiveRounds: 2 })).toBe(true);
  });

  it('withdraws a post-edit read loop — landing an edit does not license re-reading forever', () => {
    // The kimi-k3 case: five successful edits, then App.tsx:600-659 re-read NINE times with no edit
    // failing. `editingStarted` kept withdrawal off for the whole tail of the turn. The detector
    // already demands 3 identical recent passes, which no genuine post-aging refetch reaches.
    expect(shouldWithdrawInspection({ ...base, loopActiveRounds: 5 })).toBe(true);
  });

  it('withdraws a reasoning loop even post-edit — re-reading rumination is not edit-recovery', () => {
    // Observed: model edited 5×, then looped re-reading one router file at crossSim=1.0.
    expect(shouldWithdrawInspection({ ...base, loopActiveRounds: 2 })).toBe(true);
  });

  it('does NOT withdraw during edit-recovery — the model needs reading to fix old_string', () => {
    // The chat.ts case: failed edit (old_string not in file) + crossSim=1.0; withdrawing reading only
    // forces more failing edits. The edit-recovery dead-end is handled by the graceful stop instead.
    expect(shouldWithdrawInspection({ loopActiveRounds: 4, editRecovery: true })).toBe(false);
  });
});

describe('buildPlanTransformInput', () => {
  const history: Message[] = [
    { role: 'user', content: 'add web search to the composer' },
    {
      role: 'assistant',
      content: '',
      reasoning: 'CIRCULAR REASONING that kept spiraling on the same point over and over',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'Read a.ts', payload: 'FILE CONTENTS HERE' },
  ];

  it('keeps the analysis on a normal (converged) force-write', () => {
    const out = buildPlanTransformInput(history, 100000, false);
    expect(out).toContain('Your analysis:');
    expect(out).toContain('CIRCULAR REASONING');
    expect(out).toContain('FILE CONTENTS HERE'); // findings present
    expect(out).toContain('add web search to the composer'); // task present
  });

  it('drops the analysis on a loop-triggered force-write — no spiral fed back', () => {
    const out = buildPlanTransformInput(history, 100000, true);
    expect(out).not.toContain('Your analysis:');
    expect(out).not.toContain('CIRCULAR REASONING');
    // but the clean grounding (findings + task) is still there to rebuild from
    expect(out).toContain('FILE CONTENTS HERE');
    expect(out).toContain('add web search to the composer');
  });
});
