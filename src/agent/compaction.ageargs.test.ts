import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { batchAgePayloads, compactThreshold } from './compaction.js';
import { AGED_ARG_STUB_RE, messagesToChatParams, stubCallArgs } from '../provider/toolcall.js';
import { estimateRequestTokens } from '../provider/tokens.js';

type Assistant = Extract<Message, { role: 'assistant' }>;

const OLD = 'const value = computeSomethingLong(input);\n'.repeat(60);
const NEW = 'const value = computeSomethingElse(input);\n'.repeat(60);
const HEREDOC = `cat > src/gen.ts <<'EOF'\n${'export const row = [1, 2, 3];\n'.repeat(80)}EOF`;

function session(): Message[] {
  return [
    { role: 'user', content: 'refactor it' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'e1', name: 'edit', args: { path: 'src/a.ts', old_string: OLD, new_string: NEW } },
      ],
    },
    { role: 'tool', callId: 'e1', summary: 'Edited src/a.ts (+60 -60)', payload: 'ok' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'b1', name: 'bash', args: { command: HEREDOC } }],
    },
    { role: 'tool', callId: 'b1', summary: 'Ran: cat > src/gen.ts', payload: '' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'r1', name: 'read', args: { path: 'src/b.ts' } }],
    },
    {
      role: 'tool',
      callId: 'r1',
      summary: 'Read src/b.ts lines 1-80 of 80',
      payload: 'y'.repeat(12000),
      // Frozen as a real request would have left it, so the fit-to-window cap cannot trim it.
      rendered: `Read src/b.ts lines 1-80 of 80\n\n${'y'.repeat(12000)}`,
    },
    // The active round: never touched.
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'e2', name: 'edit', args: { path: 'src/c.ts', old_string: OLD, new_string: NEW } },
      ],
    },
    { role: 'tool', callId: 'e2', summary: 'Edited src/c.ts (+60 -60)', payload: 'ok' },
  ];
}

const estimateOf = (history: Message[], window: number) => () =>
  estimateRequestTokens('system', history, [], {
    contextWindow: window,
    minGenTokens: 0,
    prefixStable: true,
  });

// Windows picked with the real sweep: one where the payloads alone fall short of the watermark and
// the arguments close the gap, and one where the payloads alone reach it.
function findWindow(needsArgs: boolean): number {
  for (let w = 1000; w < 100000; w += 50) {
    const without = session();
    if (estimateOf(without, w)() <= compactThreshold(w, 0)) continue;
    const short = batchAgePayloads(without, estimateOf(without, w), w, 0, true, false).short;
    if (!needsArgs && short === 0) return w;
    if (needsArgs && short > 0) {
      const withArgs = session();
      if (batchAgePayloads(withArgs, estimateOf(withArgs, w), w, 0, true, true).short === 0)
        return w;
    }
  }
  throw new Error('no window found');
}
const windowNeedingArgs = () => findWindow(true);
const windowWithoutArgs = () => findWindow(false);

describe('batchAgePayloads with old call arguments (REIKA_AGE_ARGS)', () => {
  it('stubs old arguments once the payloads are not enough, and never the active round', () => {
    const w = windowNeedingArgs();
    const history = session();
    const res = batchAgePayloads(history, estimateOf(history, w), w, 0, true, true);
    expect(res.args).toBeGreaterThan(0);
    expect(res.short).toBe(0);
    expect((history[1] as Assistant).argsAged || (history[3] as Assistant).argsAged).toBe(true);
    expect((history[7] as Assistant).argsAged).toBeUndefined();
    const sent = JSON.stringify(messagesToChatParams('system', history, { prefixStable: true }));
    expect(sent).toContain('chars, sent earlier]');
    // The active round's edit still goes out whole.
    expect(sent).toContain(JSON.stringify(OLD).slice(1, 40));
  });

  it('takes no arguments when the payloads reach the watermark', () => {
    const w = windowWithoutArgs();
    const history = session();
    const res = batchAgePayloads(history, estimateOf(history, w), w, 0, true, true);
    expect(res.marked).toBeGreaterThan(0);
    expect(res.args).toBe(0);
    expect(history.some(m => m.role === 'assistant' && m.argsAged)).toBe(false);
  });

  it('is a no-op on arguments with the flag off', () => {
    const w = windowNeedingArgs();
    const history = session();
    const res = batchAgePayloads(history, estimateOf(history, w), w, 0, true, false);
    expect(res.args).toBe(0);
    expect(res.short).toBeGreaterThan(0);
    expect(history.some(m => m.role === 'assistant' && m.argsAged)).toBe(false);
  });
});

describe('stubCallArgs', () => {
  it("keeps a bash command's first line and stubs the rest", () => {
    const out = stubCallArgs('bash', { command: HEREDOC });
    expect(out.command).toBe(`cat > src/gen.ts <<'EOF' …[${HEREDOC.length} chars, sent earlier]`);
  });

  it('stubs long strings and keeps the path and short values', () => {
    const out = stubCallArgs('edit', {
      path: 'src/a.ts',
      old_string: OLD,
      new_string: NEW,
      replace_all: true,
    });
    expect(out).toEqual({
      path: 'src/a.ts',
      old_string: `[${OLD.length} chars, sent earlier]`,
      new_string: `[${NEW.length} chars, sent earlier]`,
      replace_all: true,
    });
  });

  it('leaves a call whose arguments are short as they are', () => {
    const args = { path: 'src/a.ts', old_string: 'x'.repeat(150), new_string: 'y' };
    expect(stubCallArgs('edit', args)).toBe(args);
  });

  it('writes stubs the echo counter recognizes', () => {
    const out = stubCallArgs('edit', { path: 'a', old_string: OLD, new_string: NEW });
    expect(AGED_ARG_STUB_RE.test(String(out.old_string))).toBe(true);
    expect(AGED_ARG_STUB_RE.test(String(stubCallArgs('bash', { command: HEREDOC }).command))).toBe(
      true,
    );
    expect(AGED_ARG_STUB_RE.test(OLD)).toBe(false);
  });
});
