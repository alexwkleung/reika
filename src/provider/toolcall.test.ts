import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { messagesToOpenAI } from './toolcall.js';

// Total serialized characters of a built request — content plus tool_call JSON.
function requestChars(out: unknown[]): number {
  return (out as Array<{ content?: unknown; tool_calls?: unknown }>).reduce((n, m) => {
    const content = typeof m.content === 'string' ? m.content.length : 0;
    const calls = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
    return n + content + calls;
  }, 0);
}

describe('messagesToOpenAI', () => {
  it('prepends the system prompt as the first message', () => {
    const out = messagesToOpenAI('SYSTEM', []);
    expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM' });
  });

  it('serializes a basic user → assistant exchange', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = messagesToOpenAI('sys', history);
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
    const out = messagesToOpenAI('sys', history);
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
    const out = messagesToOpenAI('sys', history);
    const toolMsg = out[3] as { role: string; tool_call_id: string; name?: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.name).toBe('grep');
  });

  it('includes the payload in the fresh tool block but only summary in older ones', () => {
    const history: Message[] = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'old', name: 'read', args: {} }],
      },
      { role: 'tool', callId: 'old', summary: 'old summary', payload: 'OLD PAYLOAD' },
      { role: 'user', content: 'turn 2' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'fresh', name: 'read', args: {} }],
      },
      { role: 'tool', callId: 'fresh', summary: 'fresh summary', payload: 'FRESH PAYLOAD' },
    ];
    const out = messagesToOpenAI('sys', history) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const oldTool = out.find(m => m.tool_call_id === 'old');
    const freshTool = out.find(m => m.tool_call_id === 'fresh');
    expect(oldTool?.content).toBe('old summary');
    expect(oldTool?.content).not.toContain('OLD PAYLOAD');
    expect(freshTool?.content).toContain('FRESH PAYLOAD');
  });

  it('leaves fresh payloads untouched when no context window is given', () => {
    const big = 'Z'.repeat(100_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload: big },
    ];
    const out = messagesToOpenAI('sys', history) as unknown as Array<{
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
    const out = messagesToOpenAI('sys', history, { contextWindow: 16384 });
    const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
      content?: string;
    };
    expect(tool?.content).toContain('to fit the context window');
    // The invariant that matters: the serialized request never exceeds the window.
    expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
  });

  it('keeps both the head and the tail when truncating (conclusion survives)', () => {
    // Build/command output puts the result at the end — the tail must survive.
    const payload = 'HEAD_START' + 'x'.repeat(100_000) + 'TAIL_END_dmg_path';
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'c', summary: 's', payload },
    ];
    const out = messagesToOpenAI('sys', history, { contextWindow: 16384 });
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
    const out = messagesToOpenAI('sys', history, { contextWindow: 16384 });
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
      const out = messagesToOpenAI('sys', history, { contextWindow: 16384, calibration: cal });
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
    const out = messagesToOpenAI('sys', history, { contextWindow: 16384, calibration: 0.1 });
    const tool = out.find(m => (m as { tool_call_id?: string }).tool_call_id === 'c') as {
      content?: string;
    };
    expect(tool?.content).toContain('to fit the context window');
    expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
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
    const out = messagesToOpenAI('sys', history, { contextWindow: 16384, calibration: 1.3 });
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
    const out = messagesToOpenAI('sys', history, { contextWindow: 16384 }) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const tool = out.find(m => m.tool_call_id === 'c');
    expect(tool?.content).toContain(small);
    expect(tool?.content).not.toContain('to fit the context window');
  });

  it('skips error and system messages (UI-only)', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'error', content: 'something broke' },
      { role: 'system', content: 'a slash command output' },
      { role: 'assistant', content: 'ok' },
    ];
    const out = messagesToOpenAI('sys', history);
    const roles = out.map(m => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant']);
  });

  it('skips meta user messages (slash-command echoes are UI-only)', () => {
    const history: Message[] = [
      { role: 'user', content: '/model', meta: true },
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: 'real answer' },
    ];
    const out = messagesToOpenAI('sys', history);
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out.find(m => m.role === 'user')?.content).toBe('real question');
  });

  it('merges compaction recaps into the leading system message, not as separate turns', () => {
    const history: Message[] = [
      { role: 'compaction', content: 'RECAP OF EARLIER TURNS' },
      { role: 'user', content: 'now do this' },
    ];
    const out = messagesToOpenAI('BASE SYSTEM', history);
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
    const out = messagesToOpenAI('BASE', history);
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
    const out = messagesToOpenAI('BASE', history);
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
    const out = messagesToOpenAI('sys', history);
    const assistants = out.filter(m => m.role === 'assistant') as Array<{
      reasoning_content?: string;
    }>;
    // The resolved earlier round's reasoning is dropped; the active round's is kept.
    expect(assistants[0].reasoning_content).toBeUndefined();
    expect(assistants[1].reasoning_content).toBe('current thinking');
  });

  it('drops reasoning from a completed (final-answer) assistant message', () => {
    const history: Message[] = [{ role: 'assistant', content: 'answer', reasoning: 'thinking…' }];
    const out = messagesToOpenAI('sys', history);
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
    const out = messagesToOpenAI('sys', history, { reasoningRounds: 2 });
    const reasonings = out
      .filter(m => m.role === 'assistant')
      .map(m => (m as { reasoning_content?: string }).reasoning_content);
    // Oldest round pruned; the last two kept.
    expect(reasonings).toEqual([undefined, 'think 2', 'think 3']);
  });
});
