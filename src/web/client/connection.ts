import type { StreamStatus } from './eventstream.js';
import type { SignInResult } from './link.js';

// What the banner says about sign-in and the stream; null once the stream is open.

export type Connection = { signIn: SignInResult | null; stream: StreamStatus | null };

const NEW_LINK = 'press Enter in the terminal running `reika web` for a new one';

export function connectionNotice(c: Connection): string | null {
  if (!c.signIn) return 'Signing in…';
  switch (c.signIn.kind) {
    case 'link-dead':
      return `This link was already used or has expired: ${NEW_LINK}.`;
    case 'no-link':
      return 'Not signed in: open the link `reika web` printed.';
    case 'error':
      return c.signIn.message;
    case 'signed-in':
      switch (c.stream) {
        case 'open':
          return null;
        case 'reconnecting':
          return 'Connection lost; reconnecting…';
        case 'signed-out':
          return `The server no longer accepts this tab (it was restarted): ${NEW_LINK}.`;
        default:
          return 'Connecting…';
      }
  }
}
