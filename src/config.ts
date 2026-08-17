import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutoApproveMode, Config, DefaultMode, Profile } from './types.js';
import { DEFAULT_MIN_GEN_TOKENS } from './provider/budget.js';

// Precedence: shell env > cwd .env > ~/.config/reika/.env
// dotenv defaults to no-override, so loading cwd first then global gives the right order.
dotenv.config();
dotenv.config({ path: join(homedir(), '.config', 'reika', '.env') });

export function loadConfig(): Config {
  // REIKA_MODEL is a comma-separated list of models served by the default base URL.
  // The first is the active default; any extras become switchable auto-profiles (see
  // loadProfiles). A single value behaves exactly as before.
  const models = (process.env.REIKA_MODEL ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (models.length === 0) {
    throw new Error(
      'REIKA_MODEL is required. Set it in your shell, a .env in the current directory, or ~/.config/reika/.env.',
    );
  }
  const model = models[0];
  const baseURL = process.env.REIKA_BASE_URL ?? 'http://localhost:11434/v1';
  validateBaseURL(baseURL, 'REIKA_BASE_URL');
  const apiKey = process.env.REIKA_API_KEY ?? 'no-key';
  const maxTokens = parseIntOrUndef(process.env.REIKA_MAX_TOKENS);
  const contextWindow = parseIntOrUndef(process.env.REIKA_CONTEXT_WINDOW);
  // Floor at 256 so a misconfigured tiny value can't starve generation entirely.
  const minGenTokens = Math.max(
    256,
    parseIntOrUndef(process.env.REIKA_MIN_GEN_TOKENS) ?? DEFAULT_MIN_GEN_TOKENS,
  );
  const defaultProfile: Profile = {
    model,
    baseURL,
    apiKey,
    maxTokens,
    contextWindow,
    minGenTokens,
  };
  return {
    baseURL,
    apiKey,
    model,
    models,
    maxTokens,
    contextWindow,
    minGenTokens,
    maxTurns: parseInt(process.env.REIKA_MAX_TURNS ?? '12', 10),
    repoMapBudget: parseInt(process.env.REIKA_REPO_MAP_BUDGET ?? '3200', 10),
    autoApprove: parseAutoApprove(process.env.REIKA_AUTO_APPROVE),
    subagentModel: emptyToUndefined(process.env.REIKA_SUBAGENT_MODEL),
    subagentBaseURL: emptyToUndefined(process.env.REIKA_SUBAGENT_BASE_URL),
    subagentApiKey: emptyToUndefined(process.env.REIKA_SUBAGENT_API_KEY),
    subagentMaxTurns: parseInt(process.env.REIKA_SUBAGENT_MAX_TURNS ?? '6', 10),
    searxngUrl: emptyToUndefined(process.env.REIKA_SEARXNG_URL),
    profiles: loadProfiles(defaultProfile, models),
    maxSearchesPerTurn: parseInt(process.env.REIKA_MAX_SEARCHES_PER_TURN ?? '3', 10),
    maxFetchesPerTurn: parseInt(process.env.REIKA_MAX_FETCHES_PER_TURN ?? '5', 10),
    bashTimeoutMs: parseInt(process.env.REIKA_BASH_TIMEOUT_MS ?? '300000', 10),
    // Floor at 1 so the active tool-call round always keeps its reasoning (required for
    // the reasoning roundtrip on providers that validate it).
    reasoningRounds: Math.max(1, parseIntOrUndef(process.env.REIKA_REASONING_ROUNDS) ?? 2),
    ocrLangs: parseList(process.env.REIKA_OCR_LANGS),
    pasteFetch: process.env.REIKA_PASTE_FETCH !== '0',
    skillAuto: process.env.REIKA_SKILL_AUTO === '1',
    // Substitute the current user's git name/email and account slugs for <user>/<email> in the
    // scrollback and saved transcripts. Off by default: normally you want to see your own handle,
    // and the lookup costs three git subprocesses at startup that are pure waste when unused.
    anon: process.env.REIKA_ANON === '1',
  };
}

function loadProfiles(defaultProfile: Profile, models: string[]): Record<string, Profile> {
  const profiles: Record<string, Profile> = { default: defaultProfile };
  // When REIKA_MODEL lists more than one model, register each as a lightweight profile
  // keyed by its lowercased name, inheriting the default base URL/key/token config. This
  // makes `/model <model>` switch among models on the same base URL (e.g. a model router).
  // A single model registers nothing — back-compat for the common case.
  if (models.length > 1) {
    for (const m of models) {
      const key = m.toLowerCase();
      if (key === 'default' || profiles[key]) continue;
      profiles[key] = { ...defaultProfile, model: m };
    }
  }
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
    const profileMinGen = parseIntOrUndef(process.env[`REIKA_${upper}_MIN_GEN_TOKENS`]);
    const profileBaseURL = process.env[`REIKA_${upper}_BASE_URL`] ?? defaultProfile.baseURL;
    validateBaseURL(profileBaseURL, `REIKA_${upper}_BASE_URL`);
    profiles[lower] = {
      model: profileModel,
      baseURL: profileBaseURL,
      apiKey: process.env[`REIKA_${upper}_API_KEY`] ?? defaultProfile.apiKey,
      maxTokens: profileMaxTokens ?? defaultProfile.maxTokens,
      contextWindow: profileContextWindow ?? defaultProfile.contextWindow,
      minGenTokens: profileMinGen ? Math.max(256, profileMinGen) : defaultProfile.minGenTokens,
    };
  }
  return profiles;
}

function emptyToUndefined(s: string | undefined): string | undefined {
  return s && s.trim() !== '' ? s : undefined;
}

// REIKA_AUTO_APPROVE controls how much runs without a confirmation prompt:
//   'safe' (also 'true'/'1') — auto-approve ordinary actions; commands flagged dangerous
//                              (see bash.ts danger patterns) still prompt.
//   'bypass' (also 'yolo')   — approve everything, including dangerous commands. True yolo.
//   anything else / unset    — 'off': confirm every action.
// 'true'/'1' map to 'safe' (not 'bypass') so the common opt-in keeps the safety net; full
// bypass has to be asked for by name.
function parseAutoApprove(raw: string | undefined): AutoApproveMode {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'safe':
    case 'true':
    case '1':
      return 'safe';
    case 'bypass':
    case 'yolo':
      return 'bypass';
    default:
      return 'off';
  }
}

// REIKA_DEFAULT_MODE picks the mode a session starts in: 'agent' (default), 'plan', or 'vibe'.
// An unrecognized value falls back to 'agent' — fail-open, since a startup warning would have
// nowhere safe to go (stderr corrupts the Ink frame). REIKA_PLAN_EXPERIMENT=1 is the older,
// narrower spelling of REIKA_DEFAULT_MODE=plan, kept as an alias; an explicit REIKA_DEFAULT_MODE
// wins when both are set.
// Reads process.env directly rather than riding Config: App needs the value in its first-render
// state initializer, before the async config load resolves. The dotenv side effect above makes
// .env values visible by then.
export function resolveDefaultMode(): DefaultMode {
  switch ((process.env.REIKA_DEFAULT_MODE ?? '').trim().toLowerCase()) {
    case 'agent':
      return 'agent';
    case 'plan':
      return 'plan';
    case 'vibe':
      return 'vibe';
    default:
      return process.env.REIKA_PLAN_EXPERIMENT === '1' ? 'plan' : 'agent';
  }
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

function parseList(s: string | undefined): string[] | undefined {
  const items = (s ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
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
    minGenTokens: profile.minGenTokens ?? config.minGenTokens,
  };
}
