import type { WireMessage } from '../protocol.js';

// The command a running `bash` call was given, for the live block to draw the `$ command` line the
// committed chip will (#1014): without it, the output dropped a row at commit. The call running is
// the newest assistant message's next call without a result; null for any other tool, or once a
// new prompt follows.
export function runningCommand(messages: readonly WireMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const done = messages.slice(i + 1).filter(x => x.role === 'tool').length;
      const call = m.toolCalls[done];
      if (!call || call.name !== 'bash') return null;
      const command = call.args.command;
      return typeof command === 'string' ? command : null;
    }
    if (m.role === 'user' && !m.meta) return null;
  }
  return null;
}
