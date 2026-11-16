import { describe, expect, it } from 'vitest';
import type { WireMessage } from '../protocol.js';
import { runningCommand } from './livecommand.js';

const call = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, args });
const asked = (...calls: ReturnType<typeof call>[]): WireMessage =>
  ({ role: 'assistant', content: '', toolCalls: calls }) as WireMessage;
const result = (id: string): WireMessage =>
  ({ role: 'tool', callId: id, name: 'bash', summary: 'Ran: x' }) as WireMessage;

describe('runningCommand (#1014)', () => {
  it('is the next bash call without a result', () => {
    const turn = asked(call('bash', { command: 'ls' }, 'a'), call('bash', { command: 'pwd' }, 'b'));
    expect(runningCommand([turn])).toBe('ls');
    expect(runningCommand([turn, result('a')])).toBe('pwd');
  });

  it('is null for another tool, a finished round, or after a new prompt', () => {
    expect(runningCommand([asked(call('read', { path: 'a.ts' }, 'a'))])).toBeNull();
    expect(runningCommand([asked(call('bash', { command: 'ls' }, 'a')), result('a')])).toBeNull();
    expect(
      runningCommand([
        asked(call('bash', { command: 'ls' }, 'a')),
        { role: 'user', content: 'next' } as WireMessage,
      ]),
    ).toBeNull();
  });
});
