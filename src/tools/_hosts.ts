// Host policy for harness- and model-driven network egress (see #164). Every fetch of URL CONTENT
// goes through `extractUrl`, and three different things can put a URL there: the model calling
// `fetch_url`, the harness grounding a URL a write/edit introduced, and the user pasting one into
// the prompt. The first two are attacker-reachable — a fetched page can say "add this URL to the
// config", the model writes it, and grounding fires the request with no tool call and no intent —
// so those default to refusing addresses that only mean something on this machine or this LAN: the
// local model server, a metadata endpoint, a router admin page.
//
// NOT every socket the process opens, though, and the difference matters to anyone adding a network
// path later. `SearxngProvider` (search/searxng.ts) calls `fetch` directly and is deliberately
// outside this policy: its address comes from `REIKA_SEARXNG_URL`, which the user set, and a
// local-first search instance is EXPECTED on loopback — policing it would break the documented
// default setup to stop nothing. Same provenance rule as the pasted-URL exemption, reached by
// configuration rather than by an argument. The URLs a search RETURNS are a different matter: the
// model reaches those through `fetch_url`, so they are policed like anything else it names.
//
// WHAT THIS COVERS: literal addresses, in every encoding the URL parser normalizes (decimal, hex,
// octal, and short-form IPv4 all arrive here as dotted quads — locked by a test in _hosts.test.ts),
// plus every hop of a redirect chain, since the check is worthless if one 302 walks around it.
//
// WHAT THIS DOES NOT COVER: a public DNS name that resolves to a private address (DNS rebinding).
// Blocking that means resolving the name ourselves and pinning the connection to the address we
// checked, which Node's fetch gives no hook for. This is a real gap, not a covered case — it is
// documented rather than implied, because the reason to state a boundary is so nobody trusts past
// it. The practical bound on it is that the budget cap now applies to grounding too, so a rebinding
// attempt gets a couple of requests per turn, not an unbounded stream.

// Reserved IPv4 ranges, as [first octet match, predicate]. Loopback and link-local are the two that
// matter most for this threat model — 127.0.0.1 is where a local model server lives, and
// 169.254.169.254 is the cloud metadata endpoint — but the RFC1918 ranges are just as reachable
// from a developer machine, so a router admin page is as much a target as either.
const IPV4_RULES: Array<{ test: (o: number[]) => boolean; reason: string }> = [
  { test: o => o[0] === 0, reason: 'unspecified address (0.0.0.0/8)' },
  { test: o => o[0] === 10, reason: 'private network (10.0.0.0/8)' },
  { test: o => o[0] === 127, reason: 'loopback (127.0.0.0/8)' },
  { test: o => o[0] === 100 && o[1] >= 64 && o[1] <= 127, reason: 'carrier NAT (100.64.0.0/10)' },
  {
    test: o => o[0] === 169 && o[1] === 254,
    reason: 'link-local / cloud metadata (169.254.0.0/16)',
  },
  {
    test: o => o[0] === 172 && o[1] >= 16 && o[1] <= 31,
    reason: 'private network (172.16.0.0/12)',
  },
  {
    test: o => o[0] === 192 && o[1] === 0 && o[2] === 0,
    reason: 'IETF protocol block (192.0.0.0/24)',
  },
  { test: o => o[0] === 192 && o[1] === 168, reason: 'private network (192.168.0.0/16)' },
  {
    test: o => o[0] === 198 && (o[1] === 18 || o[1] === 19),
    reason: 'benchmarking range (198.18.0.0/15)',
  },
  { test: o => o[0] >= 224 && o[0] <= 239, reason: 'multicast (224.0.0.0/4)' },
  { test: o => o[0] >= 240, reason: 'reserved (240.0.0.0/4)' },
];

function parseIpv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

// Expand a (possibly `::`-compressed) IPv6 address to its 8 groups. Returns undefined for anything
// that isn't well-formed — a caller treating undefined as "not an IP literal" is correct, because a
// malformed literal is not an address this process can reach either.
export function expandIpv6(addr: string): number[] | undefined {
  const halves = addr.split('::');
  if (halves.length > 2) return undefined;

  const toGroups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    const tokens = part.split(':');
    for (const [i, tok] of tokens.entries()) {
      // A dotted tail is an embedded IPv4 address (::ffff:127.0.0.1) and occupies two groups. Only
      // legal as the final token.
      if (tok.includes('.')) {
        if (i !== tokens.length - 1) return undefined;
        const o = parseIpv4(tok);
        if (!o) return undefined;
        groups.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(tok)) return undefined;
      groups.push(parseInt(tok, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

function classifyIpv6(groups: number[]): string | undefined {
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): the reachable address is the embedded
  // v4 one, so it gets the v4 verdict rather than a separate v6 label. Without this, ::ffff:7f00:1
  // — which is how the URL parser renders ::ffff:127.0.0.1 — would read as an ordinary v6 address
  // and sail past a loopback check.
  const topFiveZero = groups.slice(0, 5).every(g => g === 0);
  if (topFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    // ::1 is loopback, not an embedded address; :: is unspecified. Both fall out of the v4 rules
    // below (0.0.0.0/8) but deserve their own wording.
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return 'loopback (::1)';
    if (groups.every(g => g === 0)) return 'unspecified address (::)';
    const v4 = IPV4_RULES.find(r => r.test(embedded));
    // ::ffff:0:0/96 is IPv4-mapped; ::/96 with a nonzero tail is the deprecated IPv4-compatible
    // form. Same verdict either way — name them apart so the reason text isn't quietly wrong.
    if (v4) return `${groups[5] === 0xffff ? 'IPv4-mapped' : 'IPv4-compatible'} ${v4.reason}`;
    return undefined;
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return 'unique local (fc00::/7)';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  // Kept in step with the IPv4 rules above, which block 224.0.0.0/4 and the deprecated ranges. An
  // asymmetry between the two families is a defect even where it isn't reachable — a reviewer
  // should not have to work out whether ff02::1 was considered and dismissed or simply missed.
  if ((groups[0] & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  if ((groups[0] & 0xffc0) === 0xfec0) return 'site-local, deprecated (fec0::/10)';
  return undefined;
}

// Reserved names that resolve to this machine or this LAN without ever touching public DNS.
// `localhost` is guaranteed loopback by RFC 6761; `.local` is mDNS and answers on the LAN.
function classifyName(host: string): string | undefined {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback name (localhost)';
  if (host.endsWith('.local')) return 'mDNS local name (.local)';
  return undefined;
}

// The policy itself: given a hostname as the URL parser produced it, return a human-readable reason
// when the address is one the agent must not reach on its own, or undefined when it is fine.
// Reason strings are user- and model-facing, so they name the range rather than just saying "no".
export function classifyPrivateHost(hostname: string): string | undefined {
  // Trailing dot is a fully-qualified form of the same name (`localhost.`), and casing is not
  // significant. The URL parser lowercases but leaves the dot.
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return 'empty host';

  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = expandIpv6(host.slice(1, -1));
    return groups ? classifyIpv6(groups) : undefined;
  }
  // A bare IPv6 literal (no brackets) can reach here from a non-URL caller.
  if (host.includes(':')) {
    const groups = expandIpv6(host);
    return groups ? classifyIpv6(groups) : undefined;
  }

  const octets = parseIpv4(host);
  if (octets) return IPV4_RULES.find(r => r.test(octets))?.reason;
  return classifyName(host);
}

// Convenience wrapper for a full URL. Returns the block reason, or undefined when the URL is
// allowed or unparseable (an unparseable URL fails later in fetch on its own terms — this function
// answers one question only, and inventing a second failure mode here would muddy the message).
export function classifyPrivateUrl(url: string): string | undefined {
  try {
    return classifyPrivateHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}
