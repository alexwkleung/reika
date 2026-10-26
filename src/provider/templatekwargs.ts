import { classifyPrivateHost } from '../tools/_hosts.js';

// Thinking templates such as LFM2.5's and Qwen3.6's render an assistant message's `<think>` only
// after the newest user message unless `preserve_thinking` is set (#798). Under prefix-stable the
// per-round ledgers ride a trailing user message, so from the first shed on the model saw none of
// its own reasoning in the turn and re-derived it (T2, lfm2.5-24b-a2b: restating in 70–75% of
// rounds after the shed, against 3–17% with the switch on). Asking for it per request leaves
// reasoning visibility to reika's own aging, which is what the estimate already bills.
//
// Local and private hosts only: a hosted API runs its own templates and has no use for the field,
// and a strict one would 400 on it. A dotless name counts as local, since it cannot be public. A
// local engine that rejects it is latched off by client.ts on an error naming the field.
export function chatTemplateKwargsFor(baseURL: string): { preserve_thinking: true } | undefined {
  // `0` reproduces an engine that never applies the field (#827's test bed).
  if (process.env.REIKA_PRESERVE_THINKING === '0') return undefined;
  return isLocalEngine(baseURL) ? { preserve_thinking: true } : undefined;
}

// A loopback, private or dotless host: an inference engine on the user's own network rather than
// a hosted API. The note round's assistant prefill (#806) is gated on it too.
export function isLocalEngine(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  return classifyPrivateHost(host) !== undefined || (!host.includes('.') && !host.includes(':'));
}
