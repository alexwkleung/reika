import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { messagesToOpenAI } from './toolcall.js';

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

  it('roundtrips reasoning_content on assistant messages', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: 'answer',
        reasoning: 'thinking…',
      },
    ];
    const out = messagesToOpenAI('sys', history);
    const assistant = out[1] as { reasoning_content?: string };
    expect(assistant.reasoning_content).toBe('thinking…');
  });
});
