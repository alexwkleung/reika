import { SESSION_ID } from './transport.js';

// Provider cache hints ride in the body, not headers: a backend with a strict schema 400s on a
// field it does not know, where an unknown header is ignored. So each goes only to the hosts whose
// docs name it, rather than to every keyed endpoint the way `x-session-id` does, and client.ts
// latches it off on a rejection that names it.

// OpenAI (routes same-key requests to one cache on pre-5.6 models) and Moonshot (asks coding agents
// for a per-session key). A router in front of either proxies under its own host and is not
// assumed to pass it through — OpenRouter reads `x-session-id` for the same purpose anyway.
const PROMPT_CACHE_KEY_HOSTS = new Set(['api.openai.com', 'api.moonshot.ai', 'api.moonshot.cn']);

function hostOf(baseURL: string): string | undefined {
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function promptCacheKeyFor(baseURL: string): string | undefined {
  const host = hostOf(baseURL);
  return host && PROMPT_CACHE_KEY_HOSTS.has(host) ? SESSION_ID : undefined;
}

// Anthropic caches nothing without a breakpoint, so Claude through OpenRouter paid full input
// price every round. The top-level form moves the breakpoint forward as the conversation grows,
// which suits reika's append-only requests; the per-block form Qwen and older Gemini need would
// mean content-part arrays through a serializer that is string-shaped end to end.
export function cacheControlFor(baseURL: string, model: string): { type: 'ephemeral' } | undefined {
  return hostOf(baseURL) === 'openrouter.ai' && model.toLowerCase().startsWith('anthropic/')
    ? { type: 'ephemeral' }
    : undefined;
}
