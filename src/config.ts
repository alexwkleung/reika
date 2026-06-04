import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, Profile } from './types.js';

// Precedence: shell env > cwd .env > ~/.config/reika/.env
// dotenv defaults to no-override, so loading cwd first then global gives the right order.
dotenv.config();
dotenv.config({ path: join(homedir(), '.config', 'reika', '.env') });

export function loadConfig(): Config {
  const model = process.env.REIKA_MODEL;
  if (!model) {
    throw new Error(
      'REIKA_MODEL is required. Set it in your shell, a .env in the current directory, or ~/.config/reika/.env.',
    );
  }
  const baseURL = process.env.REIKA_BASE_URL ?? 'http://localhost:11434/v1';
  validateBaseURL(baseURL, 'REIKA_BASE_URL');
  const apiKey = process.env.REIKA_API_KEY ?? 'no-key';
  const maxTokens = parseIntOrUndef(process.env.REIKA_MAX_TOKENS);
  const contextWindow = parseIntOrUndef(process.env.REIKA_CONTEXT_WINDOW);
  const defaultProfile: Profile = { model, baseURL, apiKey, maxTokens, contextWindow };
  return {
    baseURL,
    apiKey,
    model,
    maxTokens,
    contextWindow,
    maxTurns: parseInt(process.env.REIKA_MAX_TURNS ?? '12', 10),
    repoMapBudget: parseInt(process.env.REIKA_REPO_MAP_BUDGET ?? '3200', 10),
    autoApprove:
      process.env.REIKA_AUTO_APPROVE === 'true' || process.env.REIKA_AUTO_APPROVE === '1',
    subagentModel: emptyToUndefined(process.env.REIKA_SUBAGENT_MODEL),
    subagentBaseURL: emptyToUndefined(process.env.REIKA_SUBAGENT_BASE_URL),
    subagentApiKey: emptyToUndefined(process.env.REIKA_SUBAGENT_API_KEY),
    subagentMaxTurns: parseInt(process.env.REIKA_SUBAGENT_MAX_TURNS ?? '6', 10),
    tavilyApiKey: emptyToUndefined(process.env.REIKA_TAVILY_API_KEY),
    searxngUrl: emptyToUndefined(process.env.REIKA_SEARXNG_URL),
    profiles: loadProfiles(defaultProfile),
    maxSearchesPerTurn: parseInt(process.env.REIKA_MAX_SEARCHES_PER_TURN ?? '3', 10),
    maxFetchesPerTurn: parseInt(process.env.REIKA_MAX_FETCHES_PER_TURN ?? '5', 10),
    // Floor at 1 so the active tool-call round always keeps its reasoning (required for
    // the reasoning roundtrip on providers that validate it).
    reasoningRounds: Math.max(1, parseIntOrUndef(process.env.REIKA_REASONING_ROUNDS) ?? 2),
  };
}

function loadProfiles(defaultProfile: Profile): Record<string, Profile> {
  const profiles: Record<string, Profile> = { default: defaultProfile };
  const names = (process.env.REIKA_PROFILES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === 'default') continue;
    const upper = name.toUpperCase();
    const profileModel = process.env[`REIKA_${upper}_MODEL`];
    if (!profileModel) continue;
    const profileMaxTokens = parseIntOrUndef(process.env[`REIKA_${upper}_MAX_TOKENS`]);
    const profileContextWindow = parseIntOrUndef(process.env[`REIKA_${upper}_CONTEXT_WINDOW`]);
    const profileBaseURL = process.env[`REIKA_${upper}_BASE_URL`] ?? defaultProfile.baseURL;
    validateBaseURL(profileBaseURL, `REIKA_${upper}_BASE_URL`);
    profiles[lower] = {
      model: profileModel,
      baseURL: profileBaseURL,
      apiKey: process.env[`REIKA_${upper}_API_KEY`] ?? defaultProfile.apiKey,
      maxTokens: profileMaxTokens ?? defaultProfile.maxTokens,
      contextWindow: profileContextWindow ?? defaultProfile.contextWindow,
    };
  }
  return profiles;
}

function emptyToUndefined(s: string | undefined): string | undefined {
  return s && s.trim() !== '' ? s : undefined;
}

// Catch the common footgun of including the endpoint path in the base URL.
// The OpenAI SDK appends `/chat/completions` itself, so a base URL ending in
// `/chat/completions` produces 404s as it path-doubles.
function validateBaseURL(url: string, source: string): void {
  const normalized = url.replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions') || normalized.endsWith('/completions')) {
    throw new Error(
      `${source} should be the API root, not an endpoint. Got "${url}". ` +
        `Drop the trailing "/chat/completions" — the OpenAI SDK appends it automatically.`,
    );
  }
}

function parseIntOrUndef(s: string | undefined): number | undefined {
  if (!s || s.trim() === '') return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveProfile(config: Config, profileName: string): Config {
  const profile = config.profiles[profileName];
  if (!profile) return config;
  return {
    ...config,
    model: profile.model,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    maxTokens: profile.maxTokens,
    contextWindow: profile.contextWindow,
  };
}
