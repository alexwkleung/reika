import { afterAll, describe, expect, it } from 'vitest';
import type { Message } from '../types.js';

// This file is the dedup-OFF baseline arm: several fixtures below use byte-identical payloads as
// a convenience, which the now-default dedup layer would stub. The flag is a module const read at
// import time, and a static import is hoisted above any env assignment, so the module must come
// in through a dynamic import AFTER the pin (the pattern warm.dedup.test.ts uses for the ON arm).
const PRIOR_DEDUP = process.env.REIKA_DEDUP_PAYLOADS;
process.env.REIKA_DEDUP_PAYLOADS = '0';
afterAll(() => {
  if (PRIOR_DEDUP === undefined) delete process.env.REIKA_DEDUP_PAYLOADS;
  else process.env.REIKA_DEDUP_PAYLOADS = PRIOR_DEDUP;
});
const {
  dedupToolContent,
  droppedPayloadCount,
  hasDroppedPayloads,
  lastUserMessageIndex,
  messagesToChatParams,
  taskSpecIndex,
} = await import('./toolcall.js');

// Total serialized characters of a built request — content plus tool_call JSON.
function requestChars(out: unknown[]): number {
  return (out as Array<{ content?: unknown; tool_calls?: unknown }>).reduce((n, m) => {
    const content = typeof m.content === 'string' ? m.content.length : 0;
    const calls = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
    return n + content + calls;
  }, 0);
}

describe('messagesToChatParams', () => {
  it('prepends the system prompt as the first message', () => {
    const out = messagesToChatParams('SYSTEM', []);
    expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM' });
  });

  it('serializes a basic user → assistant exchange', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = messagesToChatParams('sys', history);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out[2]).toMatchObject({ role: 'assistant', content: 'hello' });
  });

  it('sets assistant content to null when there are tool_calls but no content', () => {
    const history: Message[] = [
      { role: 'user', content: 'do thing' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'foo' } }],
      },
      { role: 'tool', callId: 'call_1', summary: 'Read foo' },
    ];
    const out = messagesToChatParams('sys', history);
    const assistant = out[2] as { content: unknown; tool_calls?: unknown[] };
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it('includes `name` on tool messages alongside tool_call_id', () => {
    const history: Message[] = [
      { role: 'user', content: 'do thing' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'grep', args: { pattern: 'x' } }],
      },
      { role: 'tool', callId: 'call_1', summary: 'Found matches' },
    ];
    const out = messagesToChatParams('sys', history);
    const toolMsg = out[3] as { role: string; tool_call_id: string; name?: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.name).toBe('grep');
  });

  it('drops the /new receipt (meta echo + system notice) from the model-facing history', () => {
    // /new seeds the wiped scrollback with a receipt; both halves must stay UI-only so the
    // model starts the new session with an empty history (plus the user-turn backstop).
    const history: Message[] = [
      { role: 'user', content: '/new', meta: true },
      { role: 'system', content: 'New session — conversation, tokens, and mode reset.' },
    ];
    const out = messagesToChatParams('sys', history);
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '(continue)' },
    ]);
  });

  it('resolves `name` round-locally when providers reuse tool-call ids across rounds', () => {
    // Provider-issued ids are only unique per response (llama.cpp/qq2 emit `call_0` every round).
    // A global first-match labeled every result with the OLDEST round's tool — observed in the
    // field as grep and read results all serializing with name='edit'.
    const round = (name: string, summary: string): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name, args: {} }] },
      { role: 'tool', callId: 'call_0', summary },
    ];
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('edit', 'Edit failed: old_string not found in a.css'),
      ...round('grep', 'Found 9 matches for /x/'),
      ...round('read', 'Read a.css lines 1-10 of 20'),
    ];
    const out = messagesToChatParams('sys', history);
    const names = out.filter(m => m.role === 'tool').map(m => (m as { name?: string }).name);
    expect(names).toEqual(['edit', 'grep', 'read']);
  });

  it('includes the payload in the fresh tool block but only summary in older ones', () => {
    const history: Message[] = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'old', name: 'read', args: {} }],
      },
      // Past the crumb floor (#257): a payload this side of it keeps its bytes when aged.
      { role: 'tool', callId: 'old', summary: 'old summary', payload: 'OLD PAYLOAD\n'.repeat(200) },
      { role: 'user', content: 'turn 2' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'fresh', name: 'read', args: {} }],
      },
      { role: 'tool', callId: 'fresh', summary: 'fresh summary', payload: 'FRESH PAYLOAD' },
    ];
    const out = messagesToChatParams('sys', history) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const oldTool = out.find(m => m.tool_call_id === 'old');
    const freshTool = out.find(m => m.tool_call_id === 'fresh');
    expect(oldTool?.content).toBe('old summary');
    expect(freshTool?.content).toContain('FRESH PAYLOAD');
  });

  describe('task-spec pin (#227)', () => {
    // `/issue` and `/review` mandate a `gh` fetch as the opening call, so the payload that DEFINES
    // the task is the oldest — and aging is oldest-first. Observed on #213: once it collapsed, the
    // model wrote "let me re-read the issue" with no tool call and quoted issue text that does not
    // exist. The pin keeps that one small payload live for the turn that asked for it.
    const spec = (payload: string): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'bash', args: {} }] },
      {
        role: 'tool',
        callId: 'spec',
        summary: 'Ran: gh issue view 213 (505 bytes output)',
        payload,
      },
    ];
    const later = (id: string, payload: string): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', args: {} }] },
      { role: 'tool', callId: id, summary: `Read ${id}`, payload },
    ];
    const contentFor = (out: unknown[], id: string): string =>
      (out.find(m => (m as { tool_call_id?: string }).tool_call_id === id) as { content: string })
        .content;

    it("keeps the turn's opening payload live outside the trailing tool block", () => {
      const history: Message[] = [
        { role: 'user', content: 'work on issue 213' },
        ...spec('ISSUE BODY: the thing to fix'),
        ...later('a', 'A'.repeat(3000)),
        ...later('b', 'B'.repeat(3000)),
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
      expect(contentFor(out, 'spec')).toContain('ISSUE BODY: the thing to fix');
      // Everything else outside the trailing block still ages normally.
      expect(contentFor(out, 'a')).not.toContain('AAA');
    });

    it('sends the pinned spec verbatim even when the budget prices every payload at zero', () => {
      const history: Message[] = [
        { role: 'user', content: 'work on issue 213' },
        ...spec('ISSUE BODY: the thing to fix'),
        ...later('a', 'A'.repeat(120_000)),
        ...later('b', 'B'.repeat(120_000)),
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 8192 });
      expect(contentFor(out, 'spec')).toContain('ISSUE BODY: the thing to fix');
    });

    it('does not pin an opening payload larger than the spec ceiling', () => {
      const history: Message[] = [
        { role: 'user', content: 'go' },
        ...spec('D'.repeat(5000)),
        ...later('a', 'A'.repeat(3000)),
        ...later('b', 'B'.repeat(3000)),
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
      expect(contentFor(out, 'spec')).toBe('Ran: gh issue view 213 (505 bytes output)');
    });

    it("follows the turn — the previous turn's spec is released", () => {
      const history: Message[] = [
        { role: 'user', content: 'work on issue 213' },
        // Over the crumb floor (#257) and under TASK_SPEC_PIN_CHARS, so the pin is what holds it
        // and dropping the pin is observable in the content.
        ...spec('ISSUE BODY: the thing to fix. '.repeat(100)),
        { role: 'user', content: 'now do something else' },
        ...later('a', 'A'.repeat(3000)),
        ...later('b', 'B'.repeat(3000)),
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
      expect(contentFor(out, 'spec')).not.toContain('ISSUE BODY');
      expect(contentFor(out, 'a')).toContain('AAA'); // the new turn's opening call is pinned now
    });

    it('keeps the request inside the window with all three floors firing at once', () => {
      // The pin is a THIRD unconditional verbatim allocation, alongside newest-read protection and
      // the small-payload floor — each of which can allocate past a spent budget by design. This is
      // the no-400 guarantee for the case where all three fire in one round on a tight window.
      const history: Message[] = [
        { role: 'user', content: 'work on issue 213' },
        ...spec('S'.repeat(4000)), // pin, at the ceiling
        ...later('big', 'B'.repeat(200_000)), // shared split, gets capped
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'small1', name: 'grep', args: {} },
            { id: 'small2', name: 'grep', args: {} },
            { id: 'read', name: 'read', args: {} },
          ],
        },
        { role: 'tool', callId: 'small1', summary: 'Found 1 matches', payload: 'm'.repeat(1800) },
        { role: 'tool', callId: 'small2', summary: 'Found 2 matches', payload: 'n'.repeat(1800) },
        { role: 'tool', callId: 'read', summary: 'Read z', payload: 'R'.repeat(4000) },
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 8192, calibration: 1 });
      expect(contentFor(out, 'spec')).toContain('SSS'); // the pin still holds…
      // …and the whole request still fits the window at the char/4 baseline.
      expect(requestChars(out)).toBeLessThanOrEqual(8192 * 4);
    });

    it('is off under prefix-stable, where batch aging owns the pin instead', () => {
      const history: Message[] = [
        { role: 'user', content: 'work on issue 213' },
        ...spec('ISSUE BODY: the thing to fix. '.repeat(100)),
        ...later('a', 'A'.repeat(3000)),
      ];
      (history[2] as Message & { role: 'tool' }).aged = true;
      const out = messagesToChatParams('sys', history, {
        contextWindow: 16384,
        prefixStable: true,
      });
      expect(contentFor(out, 'spec')).not.toContain('ISSUE BODY');
    });
  });

  it('leaves fresh payloads untouched when no context window is given', () => {
    const big = 'Z'.repeat(100_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload: big },
    ];
    const out = messagesToChatParams('sys', history) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const tool = out.find(m => m.tool_call_id === 'c');
    expect(tool?.content).toContain(big);
    expect(tool?.content).not.toContain('to fit the context window');
  });

  it('caps an oversized fresh payload so the whole request fits the window', () => {
    const big = 'Z'.repeat(100_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload: big },
    ];
    const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
    const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
      content?: string;
    };
    expect(tool?.content).toContain('to fit the context window');
    // The invariant that matters: the serialized request never exceeds the window.
    expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
  });

  it('caps so the request fits the window even at worst-case (dense) token density', () => {
    // Regression for the observed 400: a dense multi-file turn (SVG path data / CSS / code in the
    // kept reasoning, ~1.6 chars/token) overflowed a 24,576 window because the cap assumed a looser
    // density. The invariant: the built request, counted at the pessimistic CAP_DENSITY_FLOOR (2.5,
    // i.e. ~1.6 chars/token), must still fit the window — requestChars * 2.5/4 <= window. A moderate
    // system (dense tool-def surrogate) exercises the fixed-overhead path too. Since #189 the
    // already-sent part of that overhead is charged at its measured density, so this whole-request
    // bound is no longer an identity — it holds here with room to spare, and the bound that IS
    // exact now is asserted by 'fits the window when already-sent content is counted at its
    // measured density' below.
    const window = 24576;
    const system = 'S'.repeat(10_000);
    const big = 'Z'.repeat(200_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload: big },
    ];
    const out = messagesToChatParams(system, history, { contextWindow: window, calibration: 0.9 });
    const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
      content?: string;
    };
    expect(tool?.content).toContain('to fit the context window'); // cap fired
    // Real tokens at the worst plausible density stay within the window (the no-400 guarantee).
    expect(requestChars(out) * (2.5 / 4)).toBeLessThanOrEqual(window);
  });

  it('keeps both the head and the tail when truncating (conclusion survives)', () => {
    // Build/command output puts the result at the end — the tail must survive.
    const payload = 'HEAD_START' + 'x'.repeat(100_000) + 'TAIL_END_dmg_path';
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload },
    ];
    const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
    const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
      content?: string;
    };
    expect(tool?.content).toContain('HEAD_START');
    expect(tool?.content).toContain('TAIL_END_dmg_path');
  });

  it('splits the remaining budget across multiple fresh payloads', () => {
    const big = 'Z'.repeat(100_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read', args: {} },
          { id: 'b', name: 'read', args: {} },
        ],
      },
      { role: 'tool', callId: 'a', summary: 's', payload: big },
      { role: 'tool', callId: 'b', summary: 's', payload: big },
    ];
    const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
    const a = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'a') as {
      content?: string;
    };
    const b = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'b') as {
      content?: string;
    };
    expect(a?.content).toContain('to fit the context window');
    expect(b?.content).toContain('to fit the context window');
    expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
  });

  it('tightens the cap as calibration rises (denser tokenizer)', () => {
    const big = 'Z'.repeat(100_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload: big },
    ];
    const len = (cal: number): number => {
      const out = messagesToChatParams('sys', history, { contextWindow: 16384, calibration: cal });
      const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
        content?: string;
      };
      return tool.content!.length;
    };
    // A denser tokenizer (higher calibration) leaves room for fewer payload chars.
    // (Values must be above the cap's density floor to show the effect.)
    expect(len(4)).toBeLessThan(len(2));
  });

  it('applies a density floor so a tiny calibration cannot overflow the window', () => {
    const big = 'Z'.repeat(100_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload: big },
    ];
    // Even with an absurdly low learned calibration, the floor on the fresh conversion
    // keeps the serialized request within the window.
    const out = messagesToChatParams('sys', history, { contextWindow: 16384, calibration: 0.1 });
    const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
      content?: string;
    };
    expect(tool?.content).toContain('to fit the context window');
    expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
  });

  describe('already-sent content is priced at its measured density (#189)', () => {
    // The bug: every non-fresh char was charged at CAP_DENSITY_FLOOR (2.5, i.e. 1.6 chars per
    // budget-token) even though `calibration` had already MEASURED those bytes — they went over the
    // wire on the previous request. Ordinary source tokenizes at ~3.5-4 chars/token, so retained
    // content was over-charged ~2.5x; under REIKA_PREFIX_STABLE (which never ages a live payload)
    // the over-charge only accumulates, so the fresh budget went negative mid-turn and every read
    // collapsed to the SMALL_PAYLOAD_FLOOR_CHARS exemption — 300 lines at turn 3, 60 by turn 13,
    // at a real 63% window fill.
    const WINDOW = 24576;
    const FROZEN_FILES = 5;
    const FROZEN_EACH = 'const x = 1;\n'.repeat(846); // ~11k chars → ~55k retained, as reported

    // A long prefix-stable turn: FROZEN_FILES payloads already stamped (sent on earlier requests),
    // then one never-sent read in the trailing round.
    function retainedTurn(freshPayload: string): Message[] {
      const history: Message[] = [{ role: 'user', content: 'wire up the audio player' }];
      for (let k = 0; k < FROZEN_FILES; k++) {
        const summary = `Read src/f${k}.ts lines 1-300 of 300`;
        history.push({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `old${k}`, name: 'read', args: {} }],
        });
        history.push({
          role: 'tool',
          callId: `old${k}`,
          summary,
          payload: FROZEN_EACH,
          rendered: `${summary}\n\n${FROZEN_EACH}`, // stamped = already sent, so already measured
        });
      }
      history.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'new', name: 'read', args: {} }],
      });
      history.push({
        role: 'tool',
        callId: 'new',
        summary: 'Read web/src/scripts/audio.ts lines 1-300 of 421',
        payload: freshPayload,
      });
      return history;
    }

    it('still delivers a read far above the small-payload floor at ~55k retained chars', () => {
      // 8k chars: past SMALL_PAYLOAD_FLOOR_CHARS (2048) and past PROTECTED_READ_FLOOR_CHARS (4096),
      // so nothing but the shared budget can save it. Charging the 55k retained chars at 2.5 put the
      // budget ~1.7x under water and this came back as the "entire output omitted" marker.
      const fresh = 'export function play(): void {}\n'.repeat(250); // ~8k chars
      const out = messagesToChatParams('sys prompt', retainedTurn(fresh), {
        contextWindow: WINDOW,
        calibration: 1,
        prefixStable: true,
      });
      const content = (
        out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'new') as {
          content: string;
        }
      ).content;
      expect(content).toContain(fresh);
      expect(content).not.toContain('omitted');
    });

    it('fits the window when already-sent content is counted at its measured density', () => {
      // The bound the cap now actually guarantees: measured bytes at the learned calibration
      // (floored at char/4) plus everything unmeasured at the pessimistic 2.5 stays inside the
      // window. Driven by an oversized fresh payload so the cap is the binding constraint.
      const out = messagesToChatParams('sys prompt', retainedTurn('Z'.repeat(200_000)), {
        contextWindow: WINDOW,
        calibration: 1,
        prefixStable: true,
      });
      const frozenChars =
        FROZEN_FILES * (FROZEN_EACH.length + `Read src/f0.ts lines 1-300 of 300`.length + 2);
      const rest = requestChars(out) - frozenChars;
      expect(frozenChars / 4 + (rest * 2.5) / 4).toBeLessThanOrEqual(WINDOW);
    });

    it("still charges THIS round's new reasoning at the pessimistic density", () => {
      // The 400 that motivated CAP_DENSITY_FLOOR leaked partly through freshly-kept reasoning
      // quoting SVG path data. Reasoning arriving in the trailing round has never been measured, so
      // it must stay on the pessimistic side of the split — identical bytes buy a much smaller
      // payload there than they do one round back, where calibration already counted them.
      const reasoning = 'M12 2 L3 7 v10 l9 5 9-5 V7 Z '.repeat(700); // ~20k chars of dense path data
      const build = (onTrailingRound: boolean): number => {
        const history: Message[] = [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            reasoning: onTrailingRound ? undefined : reasoning,
            toolCalls: [{ id: 'a', name: 'grep', args: {} }],
          },
          { role: 'tool', callId: 'a', summary: 'Found 3 matches' },
          {
            role: 'assistant',
            content: '',
            reasoning: onTrailingRound ? reasoning : undefined,
            toolCalls: [{ id: 'c', name: 'bash', args: {} }],
          },
          { role: 'tool', callId: 'c', summary: 'Ran: build', payload: 'Z'.repeat(100_000) },
        ];
        const out = messagesToChatParams('sys', history, {
          contextWindow: 16384,
          calibration: 1,
          reasoningRounds: 2, // keep both rounds' reasoning, so only WHERE it sits differs
        });
        return (
          out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
            content: string;
          }
        ).content.length;
      };
      expect(build(true)).toBeLessThan(build(false));
    });
  });

  it('leaves moderate context with ample room for fresh tool output', () => {
    // A realistic mid-session: some history, well under the window. A small fresh tool
    // result must survive untouched (regression: the density floor used to over-truncate).
    const history: Message[] = [
      { role: 'user', content: 'q'.repeat(4000) },
      { role: 'assistant', content: 'a'.repeat(4000) },
      { role: 'user', content: 'find matches' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'g', name: 'grep', args: {} }] },
      {
        role: 'tool',
        callId: 'g',
        summary: 'Found 7 matches',
        payload: 'file.ts:12: hit\n'.repeat(7),
      },
    ];
    const out = messagesToChatParams('sys', history, { contextWindow: 16384, calibration: 1.3 });
    const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'g') as {
      content?: string;
    };
    expect(tool?.content).toContain('file.ts:12: hit');
    expect(tool?.content).not.toContain('to fit the context window');
  });

  it('does not cap a fresh payload that fits within budget', () => {
    const small = 'ok'.repeat(100);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload: small },
    ];
    const out = messagesToChatParams('sys', history, { contextWindow: 16384 }) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const tool = out.find(m => m.tool_call_id === 'c');
    expect(tool?.content).toContain(small);
    expect(tool?.content).not.toContain('to fit the context window');
  });

  // Newest-read protection: the freshest read is the model's edit source — old_string can only
  // be assembled from bytes it actually saw, so gutting it produces the read→edit-fail→re-read
  // spiral captured in the qq2 harness-bug evidence (req-010/012/015).
  describe('newest-read protection (edit-source fidelity)', () => {
    const readRound = (id: string, payload: string): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', args: { path: 'a' } }] },
      { role: 'tool', callId: id, summary: `Read a lines 1-50 of 476`, payload },
    ];
    const contentFor = (out: unknown[], id: string): string =>
      (out.find(m => (m as { tool_call_id?: string }).tool_call_id === id) as { content: string })
        .content;

    it('sends a small newest read verbatim even when the budget prices it at zero (req-012 regression)', () => {
      // Captured bug: a 30.7k-char system prompt on a small window drove the pessimistic fresh
      // budget negative, so a 2,229-char recovery read was sent as marker-only — zero bytes of
      // content. The model could never assemble a valid old_string and spiralled.
      const system = 'S'.repeat(31_000);
      const payload = 'const line = 1;\n'.repeat(140); // ~2.2k chars, like the captured re-read
      const history: Message[] = [
        { role: 'user', content: 'implement' },
        ...readRound('r', payload),
      ];
      const out = messagesToChatParams(system, history, { contextWindow: 16384 });
      expect(contentFor(out, 'r')).toContain(payload);
      expect(contentFor(out, 'r')).not.toContain('omitted');
    });

    it('gives the newest read priority and caps the other fresh payloads instead', () => {
      const readPayload = 'x = 1\n'.repeat(500); // 3k chars — the edit source
      const bashPayload = 'Z'.repeat(100_000);
      const history: Message[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'b', name: 'bash', args: {} },
            { id: 'r', name: 'read', args: { path: 'a' } },
          ],
        },
        {
          role: 'tool',
          callId: 'b',
          summary: 'Ran: build (100000 bytes output)',
          payload: bashPayload,
        },
        { role: 'tool', callId: 'r', summary: 'Read a lines 1-500 of 500', payload: readPayload },
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
      expect(contentFor(out, 'r')).toContain(readPayload); // verbatim
      expect(contentFor(out, 'r')).not.toContain('omitted');
      expect(contentFor(out, 'b')).toContain('to fit the context window'); // bash pays instead
      expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
    });

    it('protects only the NEWEST read — an older fresh read still splits the cap', () => {
      const oldPayload = 'O'.repeat(60_000);
      const newPayload = 'y = 2\n'.repeat(500);
      const history: Message[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'r1', name: 'read', args: { path: 'a' } },
            { id: 'r2', name: 'read', args: { path: 'b' } },
          ],
        },
        { role: 'tool', callId: 'r1', summary: 'Read a lines 1-999 of 999', payload: oldPayload },
        { role: 'tool', callId: 'r2', summary: 'Read b lines 1-500 of 500', payload: newPayload },
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
      expect(contentFor(out, 'r2')).toContain(newPayload);
      expect(contentFor(out, 'r1')).toContain('to fit the context window');
      expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
    });

    it('does not protect a read too large for the floor when the budget has no room (no-400 guarantee)', () => {
      // Protection is for small recovery reads; a huge read under a starved budget must still be
      // capped — overflow safety wins at scale.
      const system = 'S'.repeat(31_000);
      const history: Message[] = [
        { role: 'user', content: 'go' },
        ...readRound('r', 'Z'.repeat(100_000)),
      ];
      const out = messagesToChatParams(system, history, { contextWindow: 16384 });
      expect(contentFor(out, 'r')).toContain('to fit the context window');
      expect(requestChars(out) * (2.5 / 4)).toBeLessThanOrEqual(16384 + 31_000 * (2.5 / 4));
    });

    it('still protects the newest read when provider tool-call ids collide across rounds (qq2 field failure)', () => {
      // llama.cpp/qq2 emit `call_0` for EVERY single-call round — ids are only unique per
      // response. A global id→name lookup resolved every result to the oldest `call_0` round (an
      // edit), so the newest read was never recognized as a read and went out fully omitted
      // despite being 561 chars — the model re-read repeatedly and received zero bytes each time.
      const system = 'S'.repeat(31_000);
      const payload = '.track-duration {\n  color: var(--x);\n}\n'.repeat(14); // ~0.5k, like the captured re-read
      const history: Message[] = [
        { role: 'user', content: 'implement' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'edit', args: {} }] },
        { role: 'tool', callId: 'call_0', summary: 'Edit failed: old_string not found in a.css' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read', args: {} }] },
        { role: 'tool', callId: 'call_0', summary: 'Read a.css lines 515-534 of 2376', payload },
      ];
      const out = messagesToChatParams(system, history, { contextWindow: 16384 });
      const tools = out.filter(m => m.role === 'tool') as Array<{ content: string; name?: string }>;
      expect(tools[1].content).toContain(payload); // verbatim — protection recognized the read
      expect(tools[1].content).not.toContain('omitted');
    });

    it('applies protection to the first prefix-stable render too', () => {
      const system = 'S'.repeat(31_000);
      const payload = 'const z = 3;\n'.repeat(170);
      const history: Message[] = [{ role: 'user', content: 'go' }, ...readRound('r', payload)];
      const out = messagesToChatParams(system, history, {
        contextWindow: 16384,
        prefixStable: true,
        stampRenders: true,
      });
      expect(contentFor(out, 'r')).toContain(payload);
      expect((history[2] as Message & { role: 'tool' }).rendered).toContain(payload);
    });
  });

  // #179: the cap arithmetic can reach <= 0 while the window still has room, and the <= 0 branch
  // dropped a payload regardless of its size — a grep answering "Found 1 matches" and a 1,573-char
  // sed both came back empty at 61% context, and the model narrowed its way to nothing.
  describe('small-payload floor (#179)', () => {
    // A budget starved by a huge system prompt: every fresh payload prices at cap <= 0. Sized
    // against the MEASURED floor the system block is now charged at (#189, SENT_DENSITY_FLOOR = 1),
    // not the 2.5 guess — at char/4 this alone is ~15k tokens of a 16,384 window.
    const STARVED = 'S'.repeat(60_000);
    const contentFor = (out: unknown[], id: string): string =>
      (out.find(m => (m as { tool_call_id?: string }).tool_call_id === id) as { content: string })
        .content;

    it('sends a trivially small non-read payload verbatim when the budget prices it at zero', () => {
      const payload = 'AGENTS.md:15:## Run / build';
      const history: Message[] = [
        { role: 'user', content: 'how do I build' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'g', name: 'grep', args: {} }] },
        { role: 'tool', callId: 'g', summary: 'Found 1 matches', payload },
      ];
      const out = messagesToChatParams(STARVED, history, { contextWindow: 16384 });
      expect(contentFor(out, 'g')).toContain(payload);
      expect(contentFor(out, 'g')).not.toContain('omitted');
    });

    it('covers a small older read that newest-read protection does not reach', () => {
      // Protection is single-slot; the 1,573-char `sed -n 1,40p` in the field report was a bash
      // result, and an earlier read in the same round gets nothing from it either.
      const small = 'export const x = 1;\n'.repeat(78); // ~1.5k, like the captured sed
      const newest = 'y\n'.repeat(10);
      const history: Message[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'b', name: 'bash', args: {} },
            { id: 'r', name: 'read', args: {} },
          ],
        },
        {
          role: 'tool',
          callId: 'b',
          summary: "Ran: sed -n '1,40p' (1573 bytes output)",
          payload: small,
        },
        { role: 'tool', callId: 'r', summary: 'Read a lines 1-10 of 10', payload: newest },
      ];
      const out = messagesToChatParams(STARVED, history, { contextWindow: 16384 });
      expect(contentFor(out, 'b')).toContain(small);
      expect(contentFor(out, 'r')).toContain(newest);
    });

    it('still caps a large payload sharing the round with a small one', () => {
      const small = 'src/a.ts:12:const x = 1;';
      const big = 'Z'.repeat(100_000);
      const history: Message[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'g', name: 'grep', args: {} },
            { id: 'b', name: 'bash', args: {} },
          ],
        },
        { role: 'tool', callId: 'g', summary: 'Found 1 matches', payload: small },
        { role: 'tool', callId: 'b', summary: 'Ran: build (100000 bytes output)', payload: big },
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
      expect(contentFor(out, 'g')).toContain(small);
      expect(contentFor(out, 'b')).toContain('to fit the context window');
      expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
    });

    it('bounds the exemption in aggregate so a round of small payloads cannot smuggle the window', () => {
      // Eight 2k results = 16k chars: the per-payload floor alone would let all eight through.
      const history: Message[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: Array.from({ length: 8 }, (_, k) => ({
            id: `g${k}`,
            name: 'grep',
            args: {},
          })),
        },
        ...Array.from({ length: 8 }, (_, k) => ({
          role: 'tool' as const,
          callId: `g${k}`,
          summary: 'Found 40 matches',
          payload: `${k}`.repeat(2000),
        })),
      ];
      const out = messagesToChatParams(STARVED, history, { contextWindow: 16384 });
      const kept = Array.from({ length: 8 }, (_, k) => contentFor(out, `g${k}`)).filter(
        c => !c.includes('omitted'),
      );
      expect(kept.length).toBeGreaterThan(0); // some small results always survive
      expect(kept.length).toBeLessThan(8); // but not 16k chars of them
    });

    it('tells a fully-omitted payload the size that would have been delivered', () => {
      // The old text said "read a narrower line range", which at cap <= 0 was false at every size:
      // the model shrank 300 -> 120 -> 70 -> 40 lines and got nothing back each time.
      const history: Message[] = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] },
        { role: 'tool', callId: 'c', summary: 'Ran: build', payload: 'Z'.repeat(5000) },
      ];
      const out = messagesToChatParams(STARVED, history, { contextWindow: 16384 });
      const content = contentFor(out, 'c');
      expect(content).toContain('5000 chars'); // the size that failed
      expect(content).toContain('2048 chars or less'); // the size that would not
    });
  });

  describe('omission marker (edit-safety wording)', () => {
    it('says how many lines of this output would arrive whole, in the unit the model controls', () => {
      // Observed on a 24k window: read(1-300) capped -> the model narrowed to read(1-150), which at
      // this file's density is 8.7k chars against a ~2k cap — still 4x over, cut again. It cannot
      // see chars-per-line, so "read a narrower range" alone left it guessing; the marker must say
      // the number. Density is measured off the payload: 150 lines at ~58 chars each fits ~35.
      const line = (n: number) => `${String(n).padStart(5)}│${'x'.repeat(50)}`;
      const payload = Array.from({ length: 150 }, (_, k) => line(k + 1)).join('\n');
      expect(payload.length).toBeGreaterThan(8000); // the observed shape, not a toy
      const history: Message[] = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
        { role: 'tool', callId: 'c', summary: 's', payload },
        // A second fresh read takes newest-read protection, so the first one is the one capped.
        { role: 'tool', callId: 'd', summary: 's2', payload: 'Z'.repeat(6000) },
      ];
      history[1] = {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c', name: 'read', args: {} },
          { id: 'd', name: 'read', args: {} },
        ],
      };
      const out = messagesToChatParams('S'.repeat(40_000), history, { contextWindow: 16384 });
      const content =
        (
          out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
            content?: string;
          }
        ).content ?? '';
      expect(content).toContain('omitted here');
      const m = /about (\d+) lines of this output fit whole/.exec(content);
      expect(m).not.toBeNull();
      const fit = Number(m![1]);
      // Under the floor and above zero — a read of `fit` lines of this file actually ships whole.
      const perLine = payload.length / 150;
      expect(fit * perLine).toBeLessThanOrEqual(2048);
      expect((fit + 1) * perLine).toBeGreaterThan(2048);
    });

    it('warns at the cut point never to span the gap with an edit old_string', () => {
      // The marker already sits AT the cut; it must also tell the model the hidden middle is
      // unknowable — otherwise it builds an old_string across the hole and the edit fails.
      const history: Message[] = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
        { role: 'tool', callId: 'c', summary: 's', payload: 'Z'.repeat(100_000) },
      ];
      const out = messagesToChatParams('sys', history, { contextWindow: 16384 });
      const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
        content?: string;
      };
      expect(tool?.content).toContain('old_string');
      expect(tool?.content).toContain('omitted here');
    });

    it('says the WHOLE output was omitted when the budget is fully exhausted', () => {
      // cap 0 used to render "…[marker]…\n\nOutput continues:" around two empty slices — which
      // reads as tool output, not as an omission.
      const system = 'S'.repeat(60_000); // see STARVED (#189): starving at the measured floor
      const history: Message[] = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] },
        {
          role: 'tool',
          callId: 'c',
          summary: 'Ran: build (5000 bytes output)',
          payload: 'Z'.repeat(5000),
        },
      ];
      const out = messagesToChatParams(system, history, { contextWindow: 16384 });
      const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
        content?: string;
      };
      expect(tool?.content).toContain('entire output');
      expect(tool?.content).toContain('to fit the context window');
      expect(tool?.content).not.toContain('Output continues');
    });

    it('keeps a fetch_url spill locator reachable when the whole page is omitted (#139)', () => {
      // The marker's remedy is "narrow it" — for fetch_url that is only followable when the page
      // is a local file, and at cap <= 0 the payload (footer included) is gone. The locator rides
      // the summary precisely so this branch still hands the model the file.
      const system = 'S'.repeat(60_000);
      const locator = '/tmp/reika-ab12cd/fetch-1.txt';
      const page = `${'word '.repeat(2000)}\n\n(Full page saved to ${locator} — read it.)`;
      const history: Message[] = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'f', name: 'fetch_url', args: {} }] },
        {
          role: 'tool',
          callId: 'f',
          summary: `Fetched https://example.com/doc (10000 chars extracted; full page saved to ${locator})`,
          payload: page,
        },
      ];
      const out = messagesToChatParams(system, history, { contextWindow: 16384 });
      const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'f') as {
        content?: string;
      };
      expect(tool?.content).toContain('entire output');
      expect(tool?.content).not.toContain('word word');
      expect(tool?.content).toContain(`full page saved to ${locator}`);
    });
  });

  it('skips error and system messages (UI-only)', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'error', content: 'something broke' },
      { role: 'system', content: 'a slash command output' },
      { role: 'assistant', content: 'ok' },
    ];
    const out = messagesToChatParams('sys', history);
    const roles = out.map(m => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant']);
  });

  it('skips meta user messages (slash-command echoes are UI-only)', () => {
    const history: Message[] = [
      { role: 'user', content: '/model', meta: true },
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: 'real answer' },
    ];
    const out = messagesToChatParams('sys', history);
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out.find(m => m.role === 'user')?.content).toBe('real question');
  });

  it('merges compaction recaps into the leading system message, not as separate turns', () => {
    const history: Message[] = [
      { role: 'compaction', content: 'RECAP OF EARLIER TURNS' },
      { role: 'user', content: 'now do this' },
    ];
    const out = messagesToChatParams('BASE SYSTEM', history);
    // Exactly one system message, carrying both the base prompt and the recap.
    expect(out.filter(m => m.role === 'system')).toHaveLength(1);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('BASE SYSTEM');
    expect(out[0].content).toContain('RECAP OF EARLIER TURNS');
    // The compaction message itself is not emitted as its own turn.
    expect(out).toHaveLength(2); // system + user
    expect(out[1]).toEqual({ role: 'user', content: 'now do this' });
  });

  it('surfaces the recap as a user turn when compaction left no user message', () => {
    // A heavily-compacted long turn: every user turn folded into the recap, only a meta echo +
    // assistant/tool remain. Some chat templates 400 without a user message ("No user query found").
    const history: Message[] = [
      { role: 'user', content: '/implement', meta: true },
      { role: 'compaction', content: 'RECAP incl. - User: add web search' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', args: {} }],
      },
      { role: 'tool', callId: 'c1', summary: 'r1' },
    ];
    const out = messagesToChatParams('BASE', history);
    const users = out.filter(m => m.role === 'user');
    expect(users).toHaveLength(1); // the request must contain a user turn
    expect(users[0].content).toContain('add web search'); // recap (carrying the task) surfaced as user
    // The recap is NOT also duplicated into the system block in this fallback path.
    expect(out[0].role).toBe('system');
    expect(out[0].content).not.toContain('RECAP');
  });

  it('injects a minimal user turn when there is no user message and no recap', () => {
    const history: Message[] = [
      { role: 'user', content: '/stats', meta: true },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c1', summary: 'r1' },
    ];
    const out = messagesToChatParams('BASE', history);
    const users = out.filter(m => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('(continue)');
    expect(out[1]).toEqual({ role: 'user', content: '(continue)' }); // right after system
  });

  it('keeps reasoning_content only on the most recent tool-call round', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        reasoning: 'old thinking',
        toolCalls: [{ id: 'c1', name: 'read', args: {} }],
      },
      { role: 'tool', callId: 'c1', summary: 'r1' },
      {
        role: 'assistant',
        content: '',
        reasoning: 'current thinking',
        toolCalls: [{ id: 'c2', name: 'read', args: {} }],
      },
      { role: 'tool', callId: 'c2', summary: 'r2' },
    ];
    const out = messagesToChatParams('sys', history);
    const assistants = out.filter(m => m.role === 'assistant') as Array<{
      reasoning_content?: string;
    }>;
    // The resolved earlier round's reasoning is dropped; the active round's is kept.
    expect(assistants[0].reasoning_content).toBeUndefined();
    expect(assistants[1].reasoning_content).toBe('current thinking');
  });

  it('drops reasoning from a completed (final-answer) assistant message', () => {
    const history: Message[] = [{ role: 'assistant', content: 'answer', reasoning: 'thinking…' }];
    const out = messagesToChatParams('sys', history);
    const assistant = out[1] as { reasoning_content?: string };
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it('keeps reasoning for the last N tool-call rounds when reasoningRounds > 1', () => {
    const round = (n: number): Message[] => [
      {
        role: 'assistant',
        content: '',
        reasoning: `think ${n}`,
        toolCalls: [{ id: `c${n}`, name: 'read', args: {} }],
      },
      { role: 'tool', callId: `c${n}`, summary: `r${n}` },
    ];
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round(1),
      ...round(2),
      ...round(3),
    ];
    const out = messagesToChatParams('sys', history, { reasoningRounds: 2 });
    const reasonings = out
      .filter(m => m.role === 'assistant')
      .map(m => (m as { reasoning_content?: string }).reasoning_content);
    // Oldest round pruned; the last two kept.
    expect(reasonings).toEqual([undefined, 'think 2', 'think 3']);
  });

  it('does not dedup repeated tool content when the flag is off', () => {
    // Two aged, byte-identical read summaries. With REIKA_DEDUP_PAYLOADS=0 (the baseline arm), both
    // survive verbatim — the dedup layer is a strict no-op when off.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }] },
      // Past the crumb floor (#257), which would otherwise keep the aged copy's bytes and make
      // "dedup is off" indistinguishable from "dedup ran and the exemption undid it".
      { role: 'tool', callId: 'a', summary: 'Read A lines 1-5 of 5', payload: 'AAA'.repeat(1000) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'read', args: {} }] },
      { role: 'tool', callId: 'b', summary: 'Read A lines 1-5 of 5', payload: 'AAA'.repeat(1000) },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'done' },
    ];
    const out = messagesToChatParams('sys', history) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    // 'a' is the turn's pinned task spec (#227) so it keeps its payload; 'b' ages to summary. With
    // dedup on, 'b' would have collapsed to a back-reference — the point here is that it doesn't.
    expect(out.find(m => m.tool_call_id === 'a')?.content).toContain('Read A lines 1-5 of 5');
    expect(out.find(m => m.tool_call_id === 'b')?.content).toBe('Read A lines 1-5 of 5');
  });
});

describe('lastUserMessageIndex', () => {
  it('finds the newest real user message', () => {
    const history: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'ok' },
    ];
    expect(lastUserMessageIndex(history)).toBe(2);
  });

  it('skips a slash-command echo, which is scrollback and not a turn boundary', () => {
    const history: Message[] = [
      { role: 'user', content: 'work on issue 213' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '/stats', meta: true },
    ];
    expect(lastUserMessageIndex(history)).toBe(0);
  });

  it('is -1 when no user message exists', () => {
    expect(lastUserMessageIndex([{ role: 'assistant', content: 'hi' }])).toBe(-1);
  });

  // What `stale=` on the spec-pin debug line means: a pin at an index BELOW this one was carried
  // over from an earlier turn rather than established by the current one.
  it('separates a pin established this turn from one carried over', () => {
    const carried: Message[] = [
      { role: 'user', content: 'work on issue 213' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'spec', summary: 'Ran: gh', payload: 'ISSUE' },
      { role: 'user', content: 'now something else' },
    ];
    expect(taskSpecIndex(carried)).toBe(2);
    expect(taskSpecIndex(carried) < lastUserMessageIndex(carried)).toBe(true); // stale
    const own: Message[] = [
      ...carried,
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'read', args: {} }] },
      { role: 'tool', callId: 'b', summary: 'Read a', payload: 'FILE' },
    ];
    expect(taskSpecIndex(own)).toBe(5);
    expect(taskSpecIndex(own) < lastUserMessageIndex(own)).toBe(false); // this turn's own
  });
});

describe('aged diff keeps a structural skeleton (#227 follow-up)', () => {
  // The #225 review run: `gh pr diff | sed -n '1,300p'` (15169 bytes) aged to its summary line at
  // 11k/24k, and the model then invented an import statement the diff never contained and defended
  // it against the file on disk for an hour. Too big for the task-spec pin by 4x, so the fix is to
  // make the hole legible rather than to keep the bytes.
  // Padded past the crossover where the skeleton stops being the cheaper of the two — a page small
  // enough that the hole marker costs more than the hunks now ships whole (agedToolContent), which
  // is a different branch from the one this block is about.
  const DIFF = [
    'diff --git a/src/tools/_spill.test.ts b/src/tools/_spill.test.ts',
    '--- a/src/tools/_spill.test.ts',
    '+++ b/src/tools/_spill.test.ts',
    '@@ -1,6 +1,7 @@ import {',
    '   spillResult,',
    '+  sweepStaleSpills,',
    ' } from ./_spill.js;',
    '@@ -106,6 +107,114 @@ describe(spillResult, () => {',
    '+const ref = await spill(grep, still needed);',
    ...Array.from(
      { length: 60 },
      (_, i) => `+  const padding${i} = 'body bytes the skeleton drops';`,
    ),
  ].join('\n');

  const history = (payload: string): Message[] => [
    { role: 'user', content: 'review 225' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'bash', args: {} }] },
    { role: 'tool', callId: 'spec', summary: 'Ran: gh pr view 225', payload: 'PR BODY' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'd', name: 'bash', args: {} }] },
    { role: 'tool', callId: 'd', summary: 'Ran: gh pr diff 225 (15169 bytes output)', payload },
    { role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'read', args: {} }] },
    { role: 'tool', callId: 'z', summary: 'Read x', payload: 'Z'.repeat(40_000) },
  ];
  const contentFor = (out: unknown[], id: string): string =>
    (out.find(m => (m as { tool_call_id?: string }).tool_call_id === id) as { content: string })
      .content;

  it('keeps file and hunk headers when the diff ages out', () => {
    const out = messagesToChatParams('sys', history(DIFF), { contextWindow: 8192 });
    const aged = contentFor(out, 'd');
    expect(aged).toContain('Ran: gh pr diff 225');
    expect(aged).toContain('diff --git a/src/tools/_spill.test.ts');
    expect(aged).toContain('@@ -106,6 +107,114 @@');
    // The bodies are exactly what must NOT survive — that is what got quoted from memory.
    expect(aged).not.toContain('sweepStaleSpills,');
    expect(aged).not.toContain('still needed');
  });

  it('tells the model it no longer has the hunks, and that disk wins', () => {
    const out = messagesToChatParams('sys', history(DIFF), { contextWindow: 8192 });
    const aged = contentFor(out, 'd');
    expect(aged).toContain('no longer in context');
    expect(aged).toContain('do not state what one adds');
    expect(aged).toContain('the file is right');
  });

  it('is bounded, so a huge diff cannot re-inflate the request as a skeleton', () => {
    const huge = Array.from(
      { length: 4000 },
      (_, i) => `@@ -${i},6 +${i},7 @@ hunk ${i}\n+body line that must not be kept ${i}`,
    ).join('\n');
    const out = messagesToChatParams('sys', history(huge), { contextWindow: 8192 });
    const aged = contentFor(out, 'd');
    expect(aged.length).toBeLessThan(2048);
    expect(aged).toContain('further structural line(s) were dropped as well');
    expect(aged).not.toContain('body line that must not be kept');
  });

  it('leaves a non-diff payload aging to its summary alone', () => {
    const out = messagesToChatParams(
      'sys',
      history('just some command output\nwith no hunks\n'.repeat(60)),
      {
        contextWindow: 8192,
      },
    );
    expect(contentFor(out, 'd')).toBe('Ran: gh pr diff 225 (15169 bytes output)');
  });

  it('ages a mid-hunk page with no structural lines to its summary alone', () => {
    // `sed -n '301,317p'` lands inside a hunk body: no headers, so there is no map worth keeping.
    // Repeated to clear the crumb floor (#257): the case is about a page with no MAP, and a page
    // small enough to keep whole never reaches the skeleton rules at all.
    const tail = Array.from({ length: 60 }, () =>
      ['+      // Gone already.', '+    }', '+  }', '+  return removed;'].join('\n'),
    ).join('\n');
    const out = messagesToChatParams('sys', history(tail), { contextWindow: 8192 });
    expect(contentFor(out, 'd')).toBe('Ran: gh pr diff 225 (15169 bytes output)');
  });

  it('does not touch the diff while it is still live', () => {
    const out = messagesToChatParams('sys', history(DIFF).slice(0, 5), { contextWindow: 32768 });
    const live = contentFor(out, 'd');
    expect(live).toContain('+  sweepStaleSpills,');
    expect(live).not.toContain('no longer in context');
  });
});

describe('aged read keeps a declaration outline (#260)', () => {
  // #260: across four `/review` runs, 7 of 8 re-reads happened with no fold — the summary already
  // said `Read src/tools/_spill.ts lines 1-244 of 244` and the model re-read the whole file anyway.
  // Coordinates were never the missing part; an outline is what makes a narrower re-read possible.
  const g = (n: number, text: string): string => `${String(n).padStart(5, ' ')}│${text}`;
  // Bodies padded past the crossover: below it the whole payload is cheaper than the outline plus
  // its marker and ships intact instead (see toolcall.agedstats.test.ts).
  const FILE = [
    g(1, "import { readFile } from 'node:fs/promises';"),
    g(2, ''),
    g(3, 'export function spillResult(text: string): string {'),
    g(4, '  const ref = makeRef(text);'),
    ...Array.from({ length: 40 }, (_, i) => g(i + 5, `  const step${i} = ref.slice(${i});`)),
    g(45, '  return ref;'),
    g(46, '}'),
    g(47, ''),
    g(48, 'export async function sweepStaleSpills(dir: string): Promise<number> {'),
    g(49, '  let removed = 0;'),
    ...Array.from({ length: 40 }, (_, i) => g(i + 50, `  removed += await sweepOne(dir, ${i});`)),
    g(90, '  return removed;'),
    g(91, '}'),
  ].join('\n');

  const history = (payload: string): Message[] => [
    { role: 'user', content: 'review the spill module' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'bash', args: {} }] },
    { role: 'tool', callId: 'spec', summary: 'Ran: gh pr view 260', payload: 'PR BODY' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'read', args: {} }] },
    { role: 'tool', callId: 'r', summary: 'Read src/tools/_spill.ts lines 1-244 of 244', payload },
    { role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'read', args: {} }] },
    { role: 'tool', callId: 'z', summary: 'Read x', payload: 'Z'.repeat(40_000) },
  ];
  const contentFor = (out: unknown[], id: string): string =>
    (out.find(m => (m as { tool_call_id?: string }).tool_call_id === id) as { content: string })
      .content;

  it('keeps top-level declarations with their line numbers, and drops the bodies', () => {
    const out = messagesToChatParams('sys', history(FILE), { contextWindow: 8192 });
    const aged = contentFor(out, 'r');
    expect(aged).toContain('Read src/tools/_spill.ts lines 1-244 of 244');
    expect(aged).toContain('export function spillResult(text: string): string {');
    expect(aged).toContain('   48│export async function sweepStaleSpills');
    expect(aged).toContain("import { readFile } from 'node:fs/promises';");
    // Bodies are the bytes; keeping them would be keeping the payload.
    expect(aged).not.toContain('const ref = makeRef');
    expect(aged).not.toContain('let removed = 0');
  });

  it('tells the model to re-read a narrow range rather than the whole file', () => {
    const aged = contentFor(
      messagesToChatParams('sys', history(FILE), { contextWindow: 8192 }),
      'r',
    );
    expect(aged).toContain('no longer in context');
    expect(aged).toContain('narrow line range');
    expect(aged).toContain('the file is right');
  });

  it('is bounded, so a huge file cannot re-inflate the request as an outline', () => {
    const huge = Array.from({ length: 3000 }, (_, i) =>
      [
        g(i * 2 + 1, `export function fn${i}(): void {`),
        g(i * 2 + 2, '  body line kept never;'),
      ].join('\n'),
    ).join('\n');
    const aged = contentFor(
      messagesToChatParams('sys', history(huge), { contextWindow: 8192 }),
      'r',
    );
    expect(aged.length).toBeLessThan(2048);
    expect(aged).toContain('further structural line(s) were dropped as well');
    expect(aged).not.toContain('body line kept never');
  });

  it('ages command output to its summary alone — no gutter, no outline', () => {
    const out = messagesToChatParams(
      'sys',
      history('export function looksLikeCode() {}\nplain\n'.repeat(60)),
      { contextWindow: 8192 },
    );
    expect(contentFor(out, 'r')).toBe('Read src/tools/_spill.ts lines 1-244 of 244');
  });

  it('ages a body-only page to its summary alone — one declaration is a fact, not a map', () => {
    const body = [
      ...Array.from({ length: 100 }, (_, i) => g(120 + i, '  const x = 1;')),
      g(220, '  return x;'),
      g(221, '}'),
    ].join('\n');
    const out = messagesToChatParams('sys', history(body), { contextWindow: 8192 });
    expect(contentFor(out, 'r')).toBe('Read src/tools/_spill.ts lines 1-244 of 244');
  });

  it('does not touch the read while it is still live', () => {
    const out = messagesToChatParams('sys', history(FILE).slice(0, 5), { contextWindow: 32768 });
    const live = contentFor(out, 'r');
    expect(live).toContain('const ref = makeRef(text);');
    expect(live).not.toContain('no longer in context');
  });

  it('counts as a dropped payload — the outline is not the content', () => {
    expect(hasDroppedPayloads(history(FILE))).toBe(true);
  });
});

describe('hasDroppedPayloads (#227)', () => {
  const round = (id: string, payload?: string): Message[] => [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', args: {} }] },
    { role: 'tool', callId: id, summary: `${id} summary`, ...(payload ? { payload } : {}) },
  ];

  it('is true when a payload-bearing result sits outside the trailing tool block', () => {
    // 'a' is the turn's pinned spec and stays live, so 'mid' is the one that actually dropped.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('a', 'SPEC'),
      ...round('mid', 'BODY'),
      ...round('b', 'FRESH'),
    ];
    expect(hasDroppedPayloads(history)).toBe(true);
  });

  it('is false while the only payload is still fresh', () => {
    const history: Message[] = [{ role: 'user', content: 'go' }, ...round('a', 'BODY')];
    expect(hasDroppedPayloads(history)).toBe(false);
  });

  it('counts how many dropped, for the debug line', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('spec', 'SPEC'), // pinned, not a drop
      ...round('a', 'BODY'),
      ...round('b', 'BODY2'),
      ...round('c', 'FRESH'),
    ];
    expect(droppedPayloadCount(history)).toBe(2);
    expect(hasDroppedPayloads(history)).toBe(true);
  });

  it('is false for results that never had a payload (nothing was dropped)', () => {
    const history: Message[] = [{ role: 'user', content: 'go' }, ...round('a'), ...round('b')];
    expect(hasDroppedPayloads(history)).toBe(false);
  });

  // The #228 reconcile: the pin keeps the spec live, so a request whose only summary-only payload
  // IS the spec has dropped nothing. Without this the notice would fire on every skill-driven turn
  // from round 1 and claim a loss that never happened.
  it('does not count the pinned task spec — the pin keeps it live', () => {
    const history: Message[] = [
      { role: 'user', content: 'work on issue 213' },
      ...round('spec', 'ISSUE BODY'),
      ...round('b', 'FRESH'),
    ];
    expect(taskSpecIndex(history)).toBe(2);
    expect(hasDroppedPayloads(history)).toBe(false);
  });

  it('still reports a real drop alongside the pinned spec', () => {
    const history: Message[] = [
      { role: 'user', content: 'work on issue 213' },
      ...round('spec', 'ISSUE BODY'),
      ...round('a', 'BODY'), // aged out — a genuine loss
      ...round('b', 'FRESH'),
    ];
    expect(taskSpecIndex(history)).toBe(2);
    expect(hasDroppedPayloads(history)).toBe(true);
  });

  it('counts a former spec once the pin has moved on to a later turn', () => {
    const history: Message[] = [
      { role: 'user', content: 'work on issue 213' },
      ...round('spec', 'ISSUE BODY'),
      { role: 'user', content: 'now something else' },
      ...round('own', 'THIS TURN'),
      ...round('b', 'FRESH'),
    ];
    expect(taskSpecIndex(history)).toBe(5); // the new turn's own opening result
    expect(hasDroppedPayloads(history)).toBe(true); // the old spec is genuinely gone now
  });

  it('keys on the sticky `aged` mark under prefix-stable, not on the trailing block', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('a', 'BODY'),
      ...round('b', 'FRESH'),
    ];
    // Prefix-stable keeps every unaged payload live however old it is.
    expect(hasDroppedPayloads(history, true)).toBe(false);
    (history[2] as Message & { role: 'tool' }).aged = true;
    expect(hasDroppedPayloads(history, true)).toBe(true);
  });
});

describe('a skeletoned diff still counts as dropped', () => {
  // The two features meet here: #229 counts dropped payloads, #234 gives an aged diff a skeleton so
  // it no longer renders as "the summary alone". The count must key off `aged`, not off the bytes —
  // otherwise the diff, the payload whose loss actually spiralled a model, is the one thing that
  // stops being counted. Prose alone wouldn't hold this; the invariant needs a test (#162).
  const DIFF = [
    'diff --git a/x.ts b/x.ts',
    '@@ -1,2 +1,3 @@',
    '+added line',
    ...Array.from({ length: 60 }, (_, i) => `+  const padding${i} = 'body bytes';`),
  ].join('\n');

  it('counts an aged diff even though it renders a skeleton, not a bare summary', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'a', summary: 'spec', payload: 'SPEC' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'd', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'd', summary: 'Ran: gh pr diff', payload: DIFF, aged: true },
    ];
    expect(droppedPayloadCount(history, true)).toBe(1);
    expect(hasDroppedPayloads(history, true)).toBe(true);

    // ...and the thing it counted really does render as more than its summary.
    const out = messagesToChatParams('sys', history, {
      contextWindow: 8192,
      prefixStable: true,
    }) as Array<{
      tool_call_id?: string;
      content: string;
    }>;
    const rendered = out.find(m => m.tool_call_id === 'd')!.content;
    expect(rendered).toContain('@@ -1,2 +1,3 @@');
    expect(rendered).not.toContain('+added line');
  });

  it('counts an aged payload small enough to still render whole', () => {
    // The same invariant one branch further along: under the crossover an aged payload keeps its
    // bytes (#260), which makes it indistinguishable from a live one by content. Keying off `aged`
    // is what keeps the ledger honest about it — the model is told the payload may vanish next
    // round, and a bytes-sniffing count would go quiet exactly here.
    const tiny = ['diff --git a/x.ts b/x.ts', '@@ -1,2 +1,3 @@', '+added line'].join('\n');
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'a', summary: 'spec', payload: 'SPEC' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'd', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'd', summary: 'Ran: gh pr diff', payload: tiny, aged: true },
    ];
    expect(droppedPayloadCount(history, true)).toBe(1);
    const out = messagesToChatParams('sys', history, {
      contextWindow: 8192,
      prefixStable: true,
    }) as Array<{ tool_call_id?: string; content: string }>;
    expect(out.find(m => m.tool_call_id === 'd')!.content).toContain('+added line');
  });
});

describe('dedupToolContent', () => {
  const tool = (callId: string, summary: string, payload?: string): Message => ({
    role: 'tool',
    callId,
    summary,
    ...(payload !== undefined ? { payload } : {}),
  });

  it('flags nothing when every tool result is distinct', () => {
    const history: Message[] = [
      tool('a', 'Read A lines 1-5 of 5', 'AAA'),
      tool('b', 'Read B lines 1-5 of 5', 'BBB'),
    ];
    expect([...dedupToolContent(history, 0)]).toEqual([]);
  });

  it('collapses simultaneous identical fresh payloads (parallel re-read), keeping the first', () => {
    // freshFrom=0 → both fresh, signature is the payload; the second identical one is the repeat.
    const history: Message[] = [
      tool('a', 'Read A lines 1-10 of 10', 'IDENTICAL'),
      tool('b', 'Read A lines 1-10 of 10', 'IDENTICAL'),
    ];
    expect([...dedupToolContent(history, 0)]).toEqual([1]);
  });

  it('collapses a repeated aged summary trail, keeping the first', () => {
    // freshFrom past the end → all aged, signature is the summary. The trail "Read A / Read A" is the
    // cross-round pattern that survives payload-aging; the later copy is stubbed.
    const history: Message[] = [
      tool('a', 'Read A lines 1-10 of 10', 'AAA'),
      { role: 'assistant', content: 'x' },
      tool('b', 'Read A lines 1-10 of 10', 'AAA'),
    ];
    expect([...dedupToolContent(history, 99)]).toEqual([2]);
  });

  it('does not dedup a fresh payload against an aged summary (different serialized forms)', () => {
    // Even with identical bytes, the aged copy serializes its summary and the fresh copy its payload —
    // different content, so the kind-prefixed signature must keep them apart.
    const history: Message[] = [tool('old', 'SAME', 'SAME'), tool('new', 'SAME', 'SAME')];
    expect([...dedupToolContent(history, 1)]).toEqual([]);
  });

  it('ignores non-tool messages', () => {
    const history: Message[] = [
      { role: 'user', content: 'dup' },
      { role: 'assistant', content: 'dup' },
      tool('a', 'Read A', 'AAA'),
    ];
    expect([...dedupToolContent(history, 0)]).toEqual([]);
  });
});

// EXPERIMENT (REIKA_PREFIX_STABLE, issue #69): prefix-stable serialization — sticky payload
// liveness, byte-frozen renders, sticky reasoning retention, and the trailing harness note.
describe('messagesToChatParams prefix-stable', () => {
  const toolRound = (id: string, payload?: string): Message[] => [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'read', args: {} }],
    },
    { role: 'tool', callId: id, summary: `${id} summary`, ...(payload ? { payload } : {}) },
  ];

  it('keeps payloads live outside the trailing block instead of collapsing to summary', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...toolRound('old', 'OLD PAYLOAD'),
      ...toolRound('fresh', 'FRESH PAYLOAD'),
    ];
    const out = messagesToChatParams('sys', history, { prefixStable: true });
    const tools = out.filter(m => m.role === 'tool') as Array<{ content: string }>;
    expect(tools[0].content).toContain('OLD PAYLOAD');
    expect(tools[1].content).toContain('FRESH PAYLOAD');
  });

  it('collapses an aged payload to summary-only', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      // Over the crumb floor (#257), which keeps a small aged payload's bytes instead.
      ...toolRound('old', 'OLD PAYLOAD\n'.repeat(200)),
      ...toolRound('fresh', 'FRESH PAYLOAD'),
    ];
    (history[2] as Message & { role: 'tool' }).aged = true;
    const out = messagesToChatParams('sys', history, { prefixStable: true });
    const tools = out.filter(m => m.role === 'tool') as Array<{ content: string }>;
    expect(tools[0].content).toBe('old summary');
    expect(tools[1].content).toContain('FRESH PAYLOAD');
  });

  it('stamps rendered bytes only when stampRenders is set (never on estimates)', () => {
    const history: Message[] = [{ role: 'user', content: 'go' }, ...toolRound('a', 'PAYLOAD')];
    const toolMsg = history[2] as Message & { role: 'tool' };
    messagesToChatParams('sys', history, { prefixStable: true });
    expect(toolMsg.rendered).toBeUndefined();
    messagesToChatParams('sys', history, { prefixStable: true, stampRenders: true });
    expect(toolMsg.rendered).toContain('PAYLOAD');
  });

  it('reuses stamped bytes verbatim even when the cap would now truncate differently', () => {
    const bigPayload = 'X'.repeat(4000);
    const history: Message[] = [{ role: 'user', content: 'go' }, ...toolRound('a', bigPayload)];
    const toolMsg = history[2] as Message & { role: 'tool' };
    // First real call: no window pressure — payload rendered in full and stamped.
    messagesToChatParams('sys', history, { prefixStable: true, stampRenders: true });
    const stamped = toolMsg.rendered!;
    expect(stamped).toContain(bigPayload);
    // Later call under a tiny window that would truncate hard: the frozen bytes must not change,
    // or the mid-history rewrite invalidates the engine's prefix cache.
    const out = messagesToChatParams('sys', history, {
      prefixStable: true,
      stampRenders: true,
      contextWindow: 1024,
      minGenTokens: 256,
    });
    expect(toolMsg.rendered).toBe(stamped);
    const tool = out.find(m => m.role === 'tool') as { content: string };
    expect(tool.content).toBe(stamped);
  });

  it('keeps reasoning until reasoningAged is set, regardless of round distance', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { ...toolRound('r1')[0], reasoning: 'think 1' } as Message,
      toolRound('r1')[1],
      { ...toolRound('r2')[0], reasoning: 'think 2' } as Message,
      toolRound('r2')[1],
    ];
    const out = messagesToChatParams('sys', history, { prefixStable: true, reasoningRounds: 1 });
    const reasonings = out
      .filter(m => m.role === 'assistant')
      .map(m => (m as { reasoning_content?: string }).reasoning_content);
    expect(reasonings).toEqual(['think 1', 'think 2']);
    (history[1] as Message & { role: 'assistant' }).reasoningAged = true;
    const out2 = messagesToChatParams('sys', history, { prefixStable: true, reasoningRounds: 1 });
    const reasonings2 = out2
      .filter(m => m.role === 'assistant')
      .map(m => (m as { reasoning_content?: string }).reasoning_content);
    expect(reasonings2).toEqual([undefined, 'think 2']);
  });

  it('appends the trailing note as the final user message', () => {
    const history: Message[] = [{ role: 'user', content: 'go' }, ...toolRound('a', 'P')];
    const out = messagesToChatParams('sys', history, { trailingNote: '--- reika status ---' });
    const last = out[out.length - 1] as { role: string; content: string };
    expect(last).toEqual({ role: 'user', content: '--- reika status ---' });
  });

  it('counts the trailing note as the user message a user-requiring template needs', () => {
    const out = messagesToChatParams('sys', [], { trailingNote: 'note' });
    expect(out.filter(m => m.role === 'user')).toHaveLength(1);
    expect((out[1] as { content: string }).content).toBe('note');
  });
});
