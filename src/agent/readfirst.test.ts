import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadFirstGate, buildReadFirstDirective, isLive, probeLine } from './readfirst.js';
import { resolveUserPath } from '../tools/_paths.js';
import type { Message } from '../types.js';

const CWD = '/repo';

// History builders. The gate reads liveness off message positions, so these mirror the shapes the
// loop actually produces: a round is an assistant message carrying tool_calls, followed by one tool
// message per call. `dispatching()` closes a history the way it looks mid-dispatch — the assistant
// has spoken and its results are not in yet, which is exactly when shouldBounce runs.
type ToolMessage = Extract<Message, { role: 'tool' }>;
const readResult = (
  path: string,
  payload: string | undefined = `bytes of ${path}`,
): ToolMessage => ({
  role: 'tool',
  callId: `t-${path}`,
  summary: `Read ${path} lines 1-10 of 10`,
  ...(payload !== undefined ? { payload } : {}),
});
const assistant = (content = ''): Message => ({ role: 'assistant', content });
const dispatching = (...before: Message[]): Message[] => [...before, assistant()];

describe('ReadFirstGate', () => {
  it('bounces the first edit to an ungrounded path, exactly once', () => {
    const gate = new ReadFirstGate(CWD);
    const history = dispatching({ role: 'user', content: 'go' });
    expect(gate.shouldBounce('src/app.ts', history)).toBe(true);
    // Re-issued without a read: fail-open, the edit runs as-is.
    expect(gate.shouldBounce('src/app.ts', history)).toBe(false);
  });

  it('does not bounce while the read that grounded the path is still live', () => {
    const gate = new ReadFirstGate(CWD);
    // Round 1 read; the model is now answering the request that carried it.
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/app.ts'),
    );
    gate.ground('src/app.ts', 2);
    expect(gate.shouldBounce('src/app.ts', history)).toBe(false);
  });

  // The regression this gate was rebuilt for: a read stays "read this turn" forever, but its payload
  // is gone from the request one round later. Grounding must expire with the bytes.
  it('bounces once the grounding read has aged out of the request', () => {
    const gate = new ReadFirstGate(CWD);
    gate.ground('src/app.ts', 2);
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/app.ts'), // index 2 — live only for the next request
      assistant(),
      readResult('src/other.ts'), // a later round displaced it
    );
    expect(gate.shouldBounce('src/app.ts', history)).toBe(true);
  });

  it('stays fail-open for a read and an edit issued in the same round', () => {
    const gate = new ReadFirstGate(CWD);
    // Mid-dispatch: the assistant's read already ran and was pushed; its edit is being dispatched
    // now. The model never saw those bytes, but this was always allowed and stays allowed.
    const history = [
      { role: 'user', content: 'go' } as Message,
      assistant(),
      readResult('src/app.ts'),
    ];
    gate.ground('src/app.ts', 2);
    expect(gate.shouldBounce('src/app.ts', history)).toBe(false);
  });

  it('never expires grounding the model authored itself (write)', () => {
    const gate = new ReadFirstGate(CWD);
    gate.ground('src/new.ts'); // no index — the content came from the model's own call args
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/other.ts'),
      assistant(),
      readResult('src/another.ts'),
    );
    expect(gate.shouldBounce('src/new.ts', history)).toBe(false);
  });

  it('does not ground on a result that carried no bytes', () => {
    const gate = new ReadFirstGate(CWD);
    // A large file's edit echo is dropped above refreshedFile's size cap, leaving a payload-less
    // result. Nothing reached the model, so nothing is grounded.
    const history = dispatching({ role: 'user', content: 'go' }, assistant(), {
      role: 'tool',
      callId: 'e1',
      summary: 'Edited src/big.ts at line 40 (+2 -0)',
    });
    gate.ground('src/big.ts', 2);
    expect(gate.shouldBounce('src/big.ts', history)).toBe(true);
  });

  it('tracks paths independently', () => {
    const gate = new ReadFirstGate(CWD);
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/a.ts'),
    );
    gate.ground('src/a.ts', 2);
    expect(gate.shouldBounce('src/a.ts', history)).toBe(false);
    expect(gate.shouldBounce('src/b.ts', history)).toBe(true);
  });

  it('normalizes path spellings to the same file', () => {
    const gate = new ReadFirstGate(CWD);
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/app.ts'),
    );
    gate.ground('./src/app.ts', 2);
    expect(gate.shouldBounce('src/app.ts', history)).toBe(false);
    expect(gate.shouldBounce('/repo/src/lib.ts', history)).toBe(true);
    // The bounce keyed the normalized form: the relative spelling is the same file.
    expect(gate.shouldBounce('src/lib.ts', history)).toBe(false);
  });

  it('honours prefix-stable liveness, where position does not decide', () => {
    const gate = new ReadFirstGate(CWD);
    const aged = readResult('src/app.ts');
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      aged, // index 2, several rounds back — still live until batch aging marks it
      assistant(),
      readResult('src/other.ts'),
    );
    gate.ground('src/app.ts', 2);
    expect(gate.shouldBounce('src/app.ts', history, true)).toBe(false);

    const gate2 = new ReadFirstGate(CWD);
    gate2.ground('src/app.ts', 2);
    aged.aged = true; // batch aging collapsed it to summary-only
    expect(gate2.shouldBounce('src/app.ts', history, true)).toBe(true);
  });
});

describe('ReadFirstGate.holdsRegion', () => {
  const EXCERPT =
    '  606│\n  607│    if (name === "clear" || name === "new") {\n  608│      setMessages([]);';

  it('is true when a live payload actually contains the region', () => {
    const gate = new ReadFirstGate(CWD);
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/app.ts', '  607│    if (name === "clear" || name === "new") {'),
    );
    gate.ground('src/app.ts', 2);
    expect(gate.holdsRegion('src/app.ts', EXCERPT, history)).toBe(true);
  });

  // The regression: a live read of a DIFFERENT part of the same file marked the whole file grounded,
  // so an old_string invented for line 607 looked grounded and got no bytes back.
  it('is false when the live read covers a different part of the same file', () => {
    const gate = new ReadFirstGate(CWD);
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/app.ts', '  560│  const [pendingShell, setPendingShell] = useState(null);'),
    );
    gate.ground('src/app.ts', 2);
    // Coarse grounding still passes — that is correct for the gate, and wrong for this question.
    expect(gate.isGrounded('src/app.ts', history)).toBe(true);
    expect(gate.holdsRegion('src/app.ts', EXCERPT, history)).toBe(false);
  });

  it('keeps every piece of a file read in chunks, not just the latest', () => {
    const gate = new ReadFirstGate(CWD);
    const history = [
      { role: 'user', content: 'go' } as Message,
      assistant(),
      readResult('src/app.ts', '  607│    if (name === "clear" || name === "new") {'),
      readResult('src/app.ts', '  900│  const unrelated = 1;'),
      assistant(),
    ];
    gate.ground('src/app.ts', 2);
    gate.ground('src/app.ts', 3); // a second chunk must not evict the first
    expect(gate.holdsRegion('src/app.ts', EXCERPT, history)).toBe(true);
  });

  it('is true for authored content, which has no payload to match against', () => {
    const gate = new ReadFirstGate(CWD);
    gate.ground('src/new.ts'); // write
    expect(gate.holdsRegion('src/new.ts', EXCERPT, dispatching(assistant()))).toBe(true);
  });

  it('is false when the region has nothing distinctive to match on', () => {
    const gate = new ReadFirstGate(CWD);
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('src/app.ts', 'anything'),
    );
    gate.ground('src/app.ts', 2);
    // Only closing punctuation: no probe, so we re-send rather than assume coverage.
    expect(gate.holdsRegion('src/app.ts', '  10│  }\n  11│);', history)).toBe(false);
  });
});

describe('probeLine', () => {
  it('strips the gutter and picks the longest distinctive line', () => {
    expect(probeLine('    5│  const a = 1;\n    6│  const somethingMuchLonger = 2;')).toBe(
      'const somethingMuchLonger = 2;',
    );
  });

  it('returns undefined when nothing clears the length floor', () => {
    expect(probeLine('   10│  }\n   11│);\n   12│')).toBeUndefined();
  });
});

describe('isLive', () => {
  it('is false for a missing, non-tool, or payload-less message', () => {
    const history = dispatching({ role: 'user', content: 'go' }, assistant());
    expect(isLive(history, 99)).toBe(false);
    expect(isLive(history, 0)).toBe(false);
    expect(isLive([...history, readResult('a.ts', undefined)], 2)).toBe(false);
  });

  it('treats only the block preceding the dispatching assistant as live', () => {
    const history = dispatching(
      { role: 'user', content: 'go' },
      assistant(),
      readResult('a.ts'), // index 2 — an earlier round
      assistant(),
      readResult('b.ts'), // index 4 — the block the model just saw
    );
    expect(isLive(history, 2)).toBe(false);
    expect(isLive(history, 4)).toBe(true);
  });
});

describe('buildReadFirstDirective', () => {
  it('states the withholding, the fix, and the fail-open escape', () => {
    const d = buildReadFirstDirective('src/app.ts');
    expect(d).toContain('NOT applied');
    expect(d).toContain('Read src/app.ts first');
    expect(d).toContain('applied as-is');
    // The absence is a fact about the context, not an accusation about the turn.
    expect(d).toContain('aged out');
  });
});

// #216: the bounce is a directive to `read`, and `read` applies no project boundary — so bouncing
// an out-of-project edit walks the model around the gate write/edit apply to that same path (#175).
// The gate is an ergonomics nudge; it must not be able to widen reach as a side effect.
describe('ReadFirstGate — out-of-project paths are never bounced', () => {
  const history = () => dispatching({ role: 'user', content: 'go' });

  it.each([
    ['a parent escape', '../outside.txt'],
    ['an absolute path elsewhere', '/etc/hosts'],
    ['a prefix-sharing sibling', '/repo-backup/x.ts'],
  ])('does not bounce %s', (_label, path) => {
    expect(new ReadFirstGate(CWD).shouldBounce(path, history())).toBe(false);
  });

  it('does not bounce a ~/ path, which bare resolve() would misread as in-project', () => {
    // norm() resolves against cwd, so `~/.aws/credentials` would become `/repo/~/.aws/credentials`
    // — inside the project, and unbounced for the wrong reason. shouldBounce uses resolveUserPath
    // so the answer is right for the right reason.
    expect(new ReadFirstGate(CWD).shouldBounce('~/.aws/credentials', history())).toBe(false);
    expect(escapesProjectProbe()).toBe(join(homedir(), '.aws/credentials'));
  });

  it('still bounces an in-project path whose name begins with two dots', () => {
    // Guards the #175 escapesProject fix from the other side: `..config` is in-project, so the
    // ordinary nudge must still fire.
    expect(new ReadFirstGate(CWD).shouldBounce('..config/x.ts', history())).toBe(true);
  });

  it('still bounces an ordinary in-project path', () => {
    expect(new ReadFirstGate(CWD).shouldBounce('src/app.ts', history())).toBe(true);
  });

  it('leaves the gate usable for in-project paths in the same turn', () => {
    // Deliberately NOT a claim about whether the escaping path lands in `bounced`: it returns
    // before that set is consulted, so recording it or not has no observable effect (verified by
    // mutation — adding it there fails nothing). What is worth pinning is the weaker, real thing:
    // an out-of-project call does not disturb the gate for the paths it does govern.
    const gate = new ReadFirstGate(CWD);
    expect(gate.shouldBounce('/etc/hosts', history())).toBe(false);
    expect(gate.shouldBounce('src/app.ts', history())).toBe(true);
    expect(gate.shouldBounce('src/app.ts', history())).toBe(false); // still exactly once
  });
});

// Small helper kept beside the test that needs it: asserts the resolution the gate relies on,
// rather than trusting the comment above it.
function escapesProjectProbe(): string {
  return resolveUserPath(CWD, '~/.aws/credentials');
}
