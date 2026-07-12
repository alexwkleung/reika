import type { Message, Tool } from '../types.js';
import { messagesToOpenAI, toolsToOpenAI } from './toolcall.js';

// Average characters per token. ~4 is the common English/code heuristic; it tends to
// slightly over-count code (which tokenizes denser) but is close enough to drive a
// context-fill gauge and a compaction trigger. We deliberately avoid pulling in a real
// tokenizer (tiktoken et al.) — see the "defer heavy libs at small-model scale" note.
// Calibrate against the provider's reported `prompt_tokens` when one is available.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Estimate the prompt-token cost of the next request *before* sending it. Serializes
// through the same path as the real call (messagesToOpenAI + toolsToOpenAI), so payload
// aging and tool definitions are reflected. Used to show fill % before the first usage
// report comes back, and as the signal that will later trigger compaction.
export function estimateRequestTokens(
  system: string,
  history: Message[],
  tools: Tool[],
  opts?: {
    contextWindow?: number;
    calibration?: number;
    reasoningRounds?: number;
    minGenTokens?: number;
    prefixStable?: boolean;
    trailingNote?: string;
  },
): number {
  // stampRenders deliberately unset: estimates must not freeze payload bytes (see toolcall.ts).
  const messages = messagesToOpenAI(system, history, {
    contextWindow: opts?.contextWindow,
    calibration: opts?.calibration,
    reasoningRounds: opts?.reasoningRounds,
    minGenTokens: opts?.minGenTokens,
    prefixStable: opts?.prefixStable,
    trailingNote: opts?.trailingNote,
  });
  const toolDefs = tools.length > 0 ? toolsToOpenAI(tools) : [];
  // A small per-message envelope (role/delimiters) the chat template adds on top of
  // the raw content; ~4 tokens/message is the usual rule of thumb.
  const envelope = messages.length * 4;
  const serialized = JSON.stringify(messages) + JSON.stringify(toolDefs);
  return estimateTokens(serialized) + envelope;
}
