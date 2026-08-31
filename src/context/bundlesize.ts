import { buildSystemPrompt } from '../agent/prompt.js';
import { estimateTokens } from '../provider/tokens.js';
import type { ContextBundle } from '../types.js';

// The opening bundle is built once per session and then carried in every request, so its size
// is a fixed prefill cost paid on every round. On a slow local endpoint (~23 tok/s measured on
// an M2 serving a 27B) round 0 alone is minutes of wall clock before the first token, and
// nothing reported how big it was — see #194. This turns the bundle into a readable number.

export type BundleSection = {
  name: string;
  chars: number;
  tokens: number;
};

// Only the sections buildSystemPrompt interpolates. fileIndex and skills live in the bundle
// but never reach the prompt (mention expansion and skill routing consume them locally), so
// counting them here would overstate the prefill cost.
export function bundleSections(bundle: ContextBundle): BundleSection[] {
  return (['projectSummary', 'repoMap', 'instructions'] as const).map(name => ({
    name,
    chars: bundle[name].length,
    tokens: estimateTokens(bundle[name]),
  }));
}

// `prompt` is the agent-mode system prompt: the sections plus the fixed rules block and cwd
// line — what round 0 actually prefills. Plan mode differs by ~150 chars; agent is the default
// and the useful reference point, so one number stays comparable across sessions.
export function formatBundleSize(bundle: ContextBundle): string {
  const sections = bundleSections(bundle);
  const chars = sections.reduce((n, s) => n + s.chars, 0);
  const tokens = sections.reduce((n, s) => n + s.tokens, 0);
  const prompt = buildSystemPrompt({ bundle, mode: 'agent' });
  return (
    `[reika:debug] bundle hash=${bundle.hash} ` +
    `${sections.map(s => `${s.name}=${s.chars}c/${s.tokens}t`).join(' ')} ` +
    `sections=${chars}c/${tokens}t prompt=${prompt.length}c/${estimateTokens(prompt)}t`
  );
}
