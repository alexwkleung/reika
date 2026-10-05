import type { Message, ToolCall } from '../src/types.js';

// Which of grind mode's seven steps (#556) left a trace in a transcript. Graded in every mode, not
// just grind: the comparison is how often agent and minimal take the same steps unprompted.
//
// Heuristics over tool calls, deliberately loose in the model's favor — `node -e` against the
// module counts as an edge-case check without judging whether the cases were good ones. The
// question is whether the step happened, and the fixture's hidden asserts judge whether it helped.

export type GrindSteps = {
  pinned: boolean; // 1: said what "done" means before the first tool call
  explored: boolean; // 2: read the target before changing it
  tested: boolean; // 5a: ran the test suite after the change
  edgeChecked: boolean; // 5b: ran a check of its own after the change
  reviewedDiff: boolean; // 6: ran `git diff` after the change
  reported: boolean; // 7: final reply says what was and was not verified
};

// Every way a fixture project's suite gets invoked: the package managers' own `test` script, the
// "run a vitest from wherever" verbs, and node's runner. Loose on purpose, like the rest of this
// file — `npx`/`dlx` fetch when the binary is absent, so they are credited even though the run may
// have failed to start, which is the same treatment `npx vitest` already had.
const TEST_RUNNER_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:-{1,2}[\w-]+\s+)*(?:run\s+)?test\b|\b(?:npx|bunx|pnpm exec|pnpm dlx|yarn dlx)\s+vitest\b|\bnode --test\b/;
const OWN_CHECK_RE = /\bnode\b|mktemp|\/tmp\//;

function command(tc: ToolCall): string {
  return tc.name === 'bash' ? String(tc.args.command ?? '') : '';
}

function isChange(tc: ToolCall, target: string): boolean {
  if (tc.name === 'edit' || tc.name === 'write') return String(tc.args.path ?? '').endsWith(target);
  const cmd = command(tc);
  // The target must be what is written to: a bare `>` test counted `cat src/chunk.js 2>/dev/null`
  // as the change and moved every later step's window to round 0.
  const at = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`(>>?|\\btee(\\s+-a)?)\\s*['"]?(\\S*/)?${at}`).test(cmd) ||
    (/\bsed\s+-i\b/.test(cmd) && cmd.includes(target))
  );
}

function readsTarget(tc: ToolCall, target: string): boolean {
  if (tc.name === 'read') return String(tc.args.path ?? '').endsWith(target);
  return command(tc).includes(target);
}

export function scoreGrindSteps(messages: Message[], target: string): GrindSteps {
  const calls = messages.flatMap(m => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
  const firstChange = calls.findIndex(tc => isChange(tc, target));
  const before = firstChange < 0 ? calls : calls.slice(0, firstChange);
  const after = firstChange < 0 ? [] : calls.slice(firstChange + 1);
  const afterCmds = after.map(command).filter(Boolean);

  const firstWithCalls = messages.find(
    m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0,
  );
  const opening = firstWithCalls?.role === 'assistant' ? (firstWithCalls.content ?? '') : '';

  let final = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content) {
      final = m.content;
      break;
    }
  }

  return {
    pinned: opening.trim().length >= 20,
    explored: before.some(tc => readsTarget(tc, target)),
    tested: afterCmds.some(c => TEST_RUNNER_RE.test(c)),
    edgeChecked: afterCmds.some(
      c => OWN_CHECK_RE.test(c) && !TEST_RUNNER_RE.test(c) && !/^\s*git\b/.test(c),
    ),
    reviewedDiff: afterCmds.some(c => /\bgit diff\b/.test(c)),
    reported:
      /\bverif(ied|y)\b|\bconfirmed\b/i.test(final) &&
      /\b(not|didn't|did not|unverified|untested|uncertain)\b/i.test(final),
  };
}

// `steps 1·2·-·5a·-·6·7` style: which steps showed, in order, for a one-line eval note.
export function formatGrindSteps(s: GrindSteps): string {
  const marks: [boolean, string][] = [
    [s.pinned, '1'],
    [s.explored, '2'],
    [s.tested, '5a'],
    [s.edgeChecked, '5b'],
    [s.reviewedDiff, '6'],
    [s.reported, '7'],
  ];
  const hit = marks.filter(([on]) => on).length;
  return `steps ${marks.map(([on, name]) => (on ? name : '-')).join('·')} (${hit}/${marks.length})`;
}
