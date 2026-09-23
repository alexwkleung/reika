// Degrade latches, one record per endpoint. Each marks something a backend refused, learned from a
// rejected request and kept so later requests stop paying the same failed round-trip:
//   - logprobs: the engine 400s on `logprobs`/`top_logprobs` (issue #134);
//   - toolChoice: it 400s on `tool_choice: 'none'`, so report rounds fall back to sending no tools;
//   - reasoningRoundtrip: it wants every `reasoning_content` it returned passed back, so neither
//     the round window nor the aging sweep may prune any (see toolcall.ts shapeRejection);
//   - toolMessageName: it refuses `name` on tool messages (OpenAI's wire shape).
// Keyed by endpoint, not held per process, because each is a fact about one server and model: a
// session switching `/model` between a strict router and a local llama.cpp — or a subagent on
// REIKA_SUBAGENT_BASE_URL running inside the parent's turn — would otherwise apply one server's
// refusals to another. The wrong-way cost is lopsided: a latch cleared too early costs one 400
// and relatches, a latch carried to the wrong server costs it context for the rest of the session
// with nothing on screen saying why.
export type EndpointLatches = {
  logprobs: boolean;
  toolChoice: boolean;
  reasoningRoundtrip: boolean;
  toolMessageName: boolean;
};

const latchesByEndpoint = new Map<string, EndpointLatches>();

// The model is part of the key: a hosted router validates per upstream model (the reasoning
// roundtrip is a thinking-mode rule), so one model's refusal says nothing about another's.
function endpointKey(endpoint: { baseURL: string; model: string }): string {
  return `${endpoint.baseURL.replace(/\/+$/, '')}\n${endpoint.model}`;
}

// The live record, created on first use. Returned by reference on purpose: a latch set mid-call is
// seen by the retry's re-serialization without re-looking it up.
export function latchesFor(endpoint: { baseURL: string; model: string }): EndpointLatches {
  const key = endpointKey(endpoint);
  let latches = latchesByEndpoint.get(key);
  if (!latches) {
    latches = {
      logprobs: false,
      toolChoice: false,
      reasoningRoundtrip: false,
      toolMessageName: false,
    };
    latchesByEndpoint.set(key, latches);
  }
  return latches;
}

// Tests only.
export function resetEndpointLatches(): void {
  latchesByEndpoint.clear();
}
