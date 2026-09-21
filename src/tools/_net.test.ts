import { describe, expect, it } from 'vitest';
import { errorCode, isOffline, offlineCode, rootMessage } from './_net.js';

// The shape undici throws for a socket failure: an outer TypeError whose text says nothing, with
// the real error (message and code) on `cause`.
function undiciError(code: string, message: string): Error {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError('fetch failed', { cause });
}

describe('errorCode / rootMessage', () => {
  it('digs the code and message out of an undici cause chain', () => {
    const e = undiciError('ENOTFOUND', 'getaddrinfo ENOTFOUND host.example');
    expect(errorCode(e)).toBe('ENOTFOUND');
    expect(rootMessage(e)).toBe('getaddrinfo ENOTFOUND host.example');
  });

  it('reads a top-level code and message when there is no cause', () => {
    const e = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(errorCode(e)).toBe('ECONNREFUSED');
    expect(rootMessage(e)).toBe('ECONNREFUSED');
  });

  it('returns no code for an error without one, and falls back to the outer message', () => {
    expect(errorCode(new Error('boom'))).toBeUndefined();
    expect(rootMessage(new Error('boom'))).toBe('boom');
    expect(rootMessage('not an error')).toBe('not an error');
  });

  it('stops on a self-referential cause chain', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(errorCode(e)).toBeUndefined();
    expect(rootMessage(e)).toBe('loop');
  });
});

describe('offlineCode', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'])(
    'treats %s as the network being down',
    code => {
      expect(offlineCode(undiciError(code, code))).toBe(code);
    },
  );

  // One server refusing, timing out, or failing TLS says nothing about the network; latching a
  // turn on it would give up on the next good URL.
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])(
    'keeps %s host-specific',
    code => {
      expect(offlineCode(undiciError(code, code))).toBeUndefined();
    },
  );

  it('is undefined for an error with no code at all', () => {
    expect(offlineCode(new Error('fetch failed'))).toBeUndefined();
  });
});

type Iface = { address: string; family: 'IPv4' | 'IPv6'; internal: boolean };
const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false): Iface => ({
  address,
  family,
  internal,
});
const ifaces = (m: Record<string, Iface[]>) => m as unknown as Parameters<typeof isOffline>[0];

describe('isOffline', () => {
  it('is online with a routable IPv4 address on any interface', () => {
    expect(
      isOffline(
        ifaces({ lo0: [iface('127.0.0.1', 'IPv4', true)], en0: [iface('10.0.0.8', 'IPv4')] }),
      ),
    ).toBe(false);
  });

  it('is online with a global IPv6 address', () => {
    expect(isOffline(ifaces({ en0: [iface('2001:db8::1', 'IPv6')] }))).toBe(false);
  });

  // The macOS shape with the radio off: loopback, and link-local on utun/awdl that never goes
  // away. Counting those would make the check unable to ever say offline.
  it('is offline with only loopback and link-local addresses', () => {
    expect(
      isOffline(
        ifaces({
          lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
          en0: [],
          utun0: [iface('fe80::9dd:e8ce:3940:ab73', 'IPv6')],
          awdl0: [iface('fe80::9c60:e9ff:fecd:2759', 'IPv6')],
          en1: [iface('169.254.12.7', 'IPv4')],
        }),
      ),
    ).toBe(true);
  });

  it('is offline with no interfaces at all', () => {
    expect(isOffline(ifaces({}))).toBe(true);
  });

  it('reads the real interface table by default without throwing', () => {
    expect(typeof isOffline()).toBe('boolean');
  });
});
