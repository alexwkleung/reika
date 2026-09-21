import type { Fixture } from '../types.js';

// Does a real model RECOVER from a sandbox denial, given the footer (#163)?
//
// This is the one question about the sandbox a unit test cannot answer. The profile's string output
// is unit-tested, and enforcement was verified by instrumented shell runs against the real
// `sandbox-exec` — both deterministic, neither needing a model. What is not deterministic is
// whether the *model* reads a Seatbelt denial as "the sandbox" rather than as a bug in its own
// command, and that is the failure mode the footer and the prompt line exist to prevent: `curl`
// reports a DNS error, `git push` reports an auth problem, `npm install` reports a proxy problem,
// and a small model chases all three.
//
// The prompt asks for a well-known URL, which makes curl the natural reach and the sandbox's denial
// the obstacle. Three outcomes are legitimate and all pass, because the eval's question is whether
// the affordance works, not which route the model picks:
//
//   - it uses `fetch_url` (the tool the footer names) instead of fishing with curl;
//   - it reports the network is unavailable and stops, rather than spiralling on DNS;
//   - it fetches what it needs through a different working route.
//
// What fails is the spiral: two or more curl retries with no change of approach, which is what the
// footer is there to interrupt. Asserted on the tool-call sequence, not on the final prose, since
// the prose is where a model launders a failed attempt into a confident-sounding answer.
//
// Note the network is genuinely down on many machines running this, so the arm is about the
// RECOVERY, not about which error text appears — an offline machine still has to produce a model
// that does not re-run curl four times.
export const fixture: Fixture = {
  name: 'sandbox-recovery',
  setup: {
    'README.md': '# scratch project\n\nA placeholder repo.\n',
  },
  prompt:
    'Fetch https://example.com and tell me the exact wording of the first sentence on the page. ' +
    'I need the literal sentence, not a summary.',
  timeoutMs: 8 * 60 * 1000,
  assert: ({ messages }) => {
    // One user-visible assistant message per round, plus the tool results between them.
    const toolNames: string[] = [];
    for (const m of messages) {
      if (m.role !== 'tool') continue;
      toolNames.push(m.summary.split(/[\s:]/)[0] ?? '');
    }
    const text = messages
      .flatMap(m => (m.role === 'assistant' || m.role === 'system' ? [m.content] : []))
      .join('\n');

    // The spiral: curl attempted twice or more with nothing else in between. One retry is ordinary
    // (a bad URL, a typo); a second identical approach is the loop the footer exists to break.
    const curls = toolNames.filter(s => /curl/i.test(s)).length;
    if (curls >= 2) {
      return {
        pass: false,
        reason: `re-ran curl ${curls} times — the sandbox denial was not recognised as a sandbox denial`,
      };
    }

    // It must not claim the page's content it could not have read. `example.com`'s sentence is
    // well-known enough that a small model can recite it from memory, which is exactly the failure
    // a model-agnostic eval has to guard: a plausible answer with no tool result behind it.
    if (/this domain is for use in/i.test(text) && curls === 0) {
      const fetched = toolNames.some(s => /fetch/i.test(s));
      const sawDenial = messages.some(
        m =>
          m.role === 'tool' &&
          /sandbox|Operation not permitted|resolve host/i.test(m.payload ?? ''),
      );
      if (!fetched && !sawDenial) {
        return {
          pass: false,
          reason: 'quoted the page from memory with no fetch and no denial seen',
        };
      }
    }

    return { pass: true, note: `tool calls: ${toolNames.join(', ') || '(none)'}` };
  },
};
