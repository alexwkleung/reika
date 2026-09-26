import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentConstructor } from '../provider/dispatcher.js';
import {
  classifyPrivateHost,
  classifyPrivateUrl,
  expandIpv6,
  PRIVATE_ADDRESS_CODE,
  publicOnlyLookup,
} from './_hosts.js';
import { errorCode } from './_net.js';

// The policy is a pure predicate, so it gets exhaustive table coverage rather than a handful of
// representative cases — an SSRF allowlist is only as good as the encodings it was actually tried
// against, and every row here is a form that has shown up in a real bypass writeup.
describe('classifyPrivateHost — blocked addresses', () => {
  const blocked: Array<[string, RegExp]> = [
    // IPv4 loopback, the local model server's home
    ['127.0.0.1', /loopback/],
    ['127.1.2.3', /loopback/],
    ['127.255.255.255', /loopback/],
    // Cloud metadata — the single most-targeted SSRF destination
    ['169.254.169.254', /link-local/],
    ['169.254.0.1', /link-local/],
    // RFC1918
    ['10.0.0.1', /private network \(10/],
    ['10.255.255.255', /private network \(10/],
    ['172.16.0.1', /private network \(172/],
    ['172.31.255.255', /private network \(172/],
    ['192.168.1.1', /private network \(192\.168/],
    // Other reserved space
    ['0.0.0.0', /unspecified/],
    ['100.64.0.1', /carrier NAT/],
    ['192.0.0.1', /IETF protocol/],
    ['198.18.0.1', /benchmarking/],
    ['224.0.0.1', /multicast/],
    ['255.255.255.255', /reserved/],
    // Reserved names
    ['localhost', /loopback name/],
    ['LOCALHOST', /loopback name/],
    ['localhost.', /loopback name/],
    ['app.localhost', /loopback name/],
    ['printer.local', /mDNS/],
    // IPv6
    ['[::1]', /loopback \(::1\)/],
    ['[::]', /unspecified/],
    ['[fc00::1]', /unique local/],
    ['[fd12:3456::1]', /unique local/],
    ['[fe80::1]', /link-local/],
    ['[febf::1]', /link-local/],
    // IPv4-mapped IPv6 — the form the URL parser produces for ::ffff:127.0.0.1
    ['[::ffff:7f00:1]', /IPv4-mapped loopback/],
    ['[::ffff:127.0.0.1]', /IPv4-mapped loopback/],
    ['[::ffff:169.254.169.254]', /IPv4-mapped link-local/],
    // Bare (unbracketed) IPv6, reachable from a non-URL caller
    ['::1', /loopback/],
    ['fe80::1', /link-local/],
    // Kept in step with the IPv4 rules, which block multicast and the deprecated ranges. Not
    // meaningfully fetchable, but an asymmetry between the two families is a defect on its own.
    ['[ff02::1]', /multicast/],
    ['[ff00::]', /multicast/],
    ['[fec0::1]', /site-local/],
    // ::/96 with a nonzero tail is IPv4-COMPATIBLE, not IPv4-mapped — same verdict, honest label.
    ['[::2]', /IPv4-compatible/],
  ];

  for (const [host, reason] of blocked) {
    it(`blocks ${host}`, () => {
      expect(classifyPrivateHost(host)).toMatch(reason);
    });
  }
});

describe('classifyPrivateHost — allowed addresses', () => {
  const allowed = [
    'example.com',
    'api.example.com',
    'localhost.example.com', // a public name that merely starts with the reserved label
    'notlocalhost',
    'mylocal', // ".local" only as a label, not a substring
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below the RFC1918 172.16/12 block
    '172.32.0.1', // just above it
    '11.0.0.1', // adjacent to 10/8
    '192.169.0.1', // adjacent to 192.168/16
    '169.253.0.1', // adjacent to link-local
    '100.63.0.1', // just below carrier NAT
    '100.128.0.1', // just above it
    '[2606:4700::1111]', // public IPv6 (Cloudflare)
    '[2001:db8::1]',
    '[::ffff:8.8.8.8]', // IPv4-mapped PUBLIC address — the mapping is not itself a reason to block
    '[64:ff9b::8.8.8.8]', // NAT64 well-known prefix onto a public address
    '[fe00::1]', // just below fe80::/10
  ];

  for (const host of allowed) {
    it(`allows ${host}`, () => {
      expect(classifyPrivateHost(host)).toBeUndefined();
    });
  }
});

// This is the assumption the whole parser rests on: obfuscated IPv4 never reaches the policy in its
// obfuscated form, because the URL parser canonicalizes it first. If a runtime change ever broke
// that, the policy would silently start allowing http://2130706433 — so it is asserted here rather
// than left as a comment.
describe('classifyPrivateUrl — encodings normalized by the URL parser', () => {
  const bypasses: Array<[string, string]> = [
    ['http://2130706433/', 'decimal'],
    ['http://0x7f000001/', 'hex'],
    ['http://0177.0.0.1/', 'octal'],
    ['http://127.1/', 'short form'],
    ['http://0/', 'bare zero'],
    ['http://127.0.0.1:11434/api/tags', 'the local model server, with a port'],
    ['http://[::1]:8080/', 'bracketed IPv6 with a port'],
    ['http://LocalHost/admin', 'mixed case'],
    ['http://user:pass@127.0.0.1/', 'userinfo in the authority'],
    ['http://169.254.169.254/latest/meta-data/', 'metadata endpoint'],
  ];

  for (const [url, label] of bypasses) {
    it(`blocks ${label}: ${url}`, () => {
      expect(classifyPrivateUrl(url)).toBeDefined();
    });
  }

  it('allows an ordinary public URL', () => {
    expect(classifyPrivateUrl('https://example.com/docs?q=1')).toBeUndefined();
  });

  it('returns undefined for an unparseable URL rather than inventing a verdict', () => {
    expect(classifyPrivateUrl('not a url')).toBeUndefined();
  });
});

describe('expandIpv6', () => {
  it('expands a compressed address to 8 groups', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('expands a full address unchanged', () => {
    expect(expandIpv6('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  it('expands an embedded IPv4 tail into two groups', () => {
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  });

  it('rejects malformed input', () => {
    expect(expandIpv6('1::2::3')).toBeUndefined();
    expect(expandIpv6('gggg::1')).toBeUndefined();
    expect(expandIpv6('1:2:3')).toBeUndefined();
    expect(expandIpv6('::1.2.3.4.5')).toBeUndefined();
  });
});

describe('publicOnlyLookup — connect-time pin (#544)', () => {
  const fake =
    (answer: Array<{ address: string; family: number }>) =>
    (_h: string, _o: object, cb: (e: null, a: typeof answer) => void) =>
      cb(null, answer);

  const run = (answer: Array<{ address: string; family: number }>) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>(resolve =>
      publicOnlyLookup(
        'rebind.example.net',
        { all: true },
        (err, address) => resolve({ err, address }),
        fake(answer),
      ),
    );

  it('passes an all-public answer through unchanged', async () => {
    const answer = [{ address: '93.184.216.34', family: 4 }];
    expect(await run(answer)).toEqual({ err: null, address: answer });
  });

  it('refuses a name that resolves to loopback', async () => {
    const { err } = await run([{ address: '127.0.0.1', family: 4 }]);
    expect(err?.code).toBe(PRIVATE_ADDRESS_CODE);
    expect(err?.message).toMatch(/rebind\.example\.net resolves to 127\.0\.0\.1, loopback/);
  });

  // The rebinding shape: one public record to pass a pre-check, one private for the connection.
  it('refuses the whole name when any record is private', async () => {
    const { err } = await run([
      { address: '93.184.216.34', family: 4 },
      { address: '::ffff:169.254.169.254', family: 6 },
    ]);
    expect(err?.code).toBe(PRIVATE_ADDRESS_CODE);
  });

  it('handles the single-address callback shape', async () => {
    const single = (_h: string, _o: object, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '10.0.0.5', 4);
    const err = await new Promise<NodeJS.ErrnoException | null>(resolve =>
      publicOnlyLookup('x.example.net', {}, e => resolve(e), single as never),
    );
    expect(err?.code).toBe(PRIVATE_ADDRESS_CODE);
  });

  // The claim that matters is that undici connects with THIS lookup, so drive a real fetch at a
  // real loopback server through a name the policy never sees as private.
  it('stops a real fetch whose name resolves to a loopback server', async () => {
    const server = createServer((_req, res) => res.end('secret'));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const Agent = await agentConstructor<{ connect: { lookup: unknown } }>();
      expect(Agent).not.toBeNull();
      const dispatcher = new Agent!({
        connect: {
          lookup: (h: string, o: object, cb: never) =>
            publicOnlyLookup(h, o, cb, fake([{ address: '127.0.0.1', family: 4 }])),
        },
      });
      const err = await fetch(`http://rebind.example.net:${port}/`, {
        dispatcher,
      } as RequestInit).catch((e: unknown) => e);
      expect(errorCode(err)).toBe(PRIVATE_ADDRESS_CODE);
    } finally {
      server.close();
    }
  });
});
