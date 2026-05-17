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
  const apiKey = process.env.REIKA_API_KEY ?? 'no-key';
  const maxTokens = parseIntOrUndef(process.env.REIKA_MAX_TOKENS);
  const defaultProfile: Profile = { model, baseURL, apiKey, maxTokens };
  return {
    baseURL,
    apiKey,
    model,
    maxTokens,
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
    profiles[lower] = {
      model: profileModel,
      baseURL: process.env[`REIKA_${upper}_BASE_URL`] ?? defaultProfile.baseURL,
      apiKey: process.env[`REIKA_${upper}_API_KEY`] ?? defaultProfile.apiKey,
      maxTokens: profileMaxTokens ?? defaultProfile.maxTokens,
    };
  }
  return profiles;
}

function emptyToUndefined(s: string | undefined): string | undefined {
  return s && s.trim() !== '' ? s : undefined;
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
  };
}
