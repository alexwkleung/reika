import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutoApproveMode, Config, DefaultMode, Profile, SkillAutoMode } from './types.js';
import { DEFAULT_MIN_GEN_TOKENS } from './provider/budget.js';

// Precedence: shell env > cwd .env > ~/.config/reika/.env
// dotenv defaults to no-override, so loading cwd first then global gives the right order.
// The keys already present before dotenv runs are the ones set at launch (`REIKA_X=1 reika`, or an
// export in the shell rc); the persisted session state (#365) defers to those and beats the files.
const launchEnvKeys = new Set(Object.keys(process.env));
dotenv.config();
dotenv.config({ path: join(homedir(), '.config', 'reika', '.env') });

export function setAtLaunch(name: string): boolean {
  return launchEnvKeys.has(name);
}

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
  // llama-server's port, matching .env.example and the quick start. The fallback only applies
  // when REIKA_BASE_URL is unset, which for a required-REIKA_MODEL config means somebody
  // running on defaults end to end.
  const baseURL = process.env.REIKA_BASE_URL ?? 'http://localhost:8080/v1';
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
    // A termination backstop for the spiral shapes the loop detectors miss, not a cost cap: a
    // cached round is nearly free on both local and API, so it is sized where a healthy complex
    // turn never lands and a spiral in headless (no ctrl-c) still ends in hours, not days.
    maxTurns: parseInt(process.env.REIKA_MAX_TURNS ?? '200', 10),
    repoMapBudget: parseInt(process.env.REIKA_REPO_MAP_BUDGET ?? '3200', 10),
    autoApprove: parseAutoApprove(process.env.REIKA_AUTO_APPROVE),
    autoApproveExplicit: (process.env.REIKA_AUTO_APPROVE ?? '').trim() !== '',
    subagentModel: emptyToUndefined(process.env.REIKA_SUBAGENT_MODEL),
    subagentBaseURL: emptyToUndefined(process.env.REIKA_SUBAGENT_BASE_URL),
    subagentApiKey: emptyToUndefined(process.env.REIKA_SUBAGENT_API_KEY),
    // Not a backstop: the last round IS the report round (#340), so this stays tight.
    subagentMaxTurns: parseInt(process.env.REIKA_SUBAGENT_MAX_TURNS ?? '8', 10),
    searxngUrl: emptyToUndefined(process.env.REIKA_SEARXNG_URL),
    cdpSearch: process.env.REIKA_CDP_SEARCH === '1',
    cdpPort: parseIntOrUndef(process.env.REIKA_CDP_PORT),
    profiles: loadProfiles(defaultProfile, models),
    maxSearchesPerTurn: parseInt(process.env.REIKA_MAX_SEARCHES_PER_TURN ?? '3', 10),
    maxFetchesPerTurn: parseInt(process.env.REIKA_MAX_FETCHES_PER_TURN ?? '5', 10),
    bashTimeoutMs: parseInt(process.env.REIKA_BASH_TIMEOUT_MS ?? '1800000', 10),
    bashIdleMs: parseInt(process.env.REIKA_BASH_IDLE_MS ?? '300000', 10),
    // Floor at 1 so the active tool-call round always keeps its reasoning (required for
    // the reasoning roundtrip on providers that validate it).
    reasoningRounds: Math.max(1, parseIntOrUndef(process.env.REIKA_REASONING_ROUNDS) ?? 2),
    ocrLangs: parseList(process.env.REIKA_OCR_LANGS),
    pasteFetch: process.env.REIKA_PASTE_FETCH !== '0',
    skillAuto: parseSkillAuto(process.env.REIKA_SKILL_AUTO),
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
    // Comma-separated like REIKA_MODEL: the profile is its first model, and each extra becomes an
    // auto-profile keyed by its own name on the same connection — a hosted router with a menu of
    // models is one profile, not one per model.
    const profileModels = (process.env[`REIKA_${upper}_MODEL`] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (profileModels.length === 0) continue;
    const profileModel = profileModels[0];
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
    for (const m of profileModels.slice(1)) {
      const key = m.toLowerCase();
      if (key === 'default' || profiles[key]) continue;
      profiles[key] = { ...profiles[lower], model: m, group: lower };
    }
  }
  return profiles;
}

function emptyToUndefined(s: string | undefined): string | undefined {
  return s && s.trim() !== '' ? s : undefined;
}

// REIKA_AUTO_APPROVE controls how much runs without a confirmation prompt:
//   'safe' (also 'true'/'1') — auto-approve ordinary actions; commands flagged dangerous
//                              (see bash.ts danger patterns) and writes outside the project
//                              still prompt. The default when unset.
//   'bypass' (also 'yolo')   — approve everything, including dangerous commands. True yolo.
//   'off' (also 'false'/'0') — confirm every action. Any unrecognized value lands here too:
//                              a typo in a permission setting should cost prompts, not safety.
// 'true'/'1' map to 'safe' (not 'bypass') so the common opt-in keeps the safety net; full
// bypass has to be asked for by name. Unset is 'safe' rather than 'off' because the danger
// scan already holds back everything an in-repo `git checkout` can't undo, and confirming each
// ordinary edit made every multi-edit session a click-through.
function parseAutoApprove(raw: string | undefined): AutoApproveMode {
  switch ((raw ?? '').trim().toLowerCase()) {
    case '':
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

// REIKA_SKILL_AUTO, three-valued like REIKA_AUTO_APPROVE. Unset is 'ask': once the confirm
// dialog made a wrong pick cost a keystroke instead of a turn, the reason to keep routing off by
// default went with it. 'apply' (also '1', the pre-#425 spelling, which then meant silent
// injection) is the only value that changes headless — a script that never opted in must not
// start receiving skill bodies because the interactive default moved. Anything unrecognized is
// 'off': a typo should cost a hint line, not a rewritten prompt.
function parseSkillAuto(raw: string | undefined): SkillAutoMode {
  switch ((raw ?? '').trim().toLowerCase()) {
    case '':
    case 'ask':
      return 'ask';
    case 'apply':
    case '1':
    case 'true':
      return 'apply';
    default:
      return 'off';
  }
}

// REIKA_DEFAULT_MODE picks the mode a session starts in: 'agent' (default), 'plan', 'vibe', or
// 'minimal'.
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
    case 'minimal':
      return 'minimal';
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

// Records a window the endpoint reported (#417) on one profile. The profile only — never the
// top-level `contextWindow`, which every profile reads as its fallback and which would hand the
// default model's window to a different model on a /model switch.
export function withProbedWindow(config: Config, profileName: string, window: number): Config {
  const profile = config.profiles[profileName];
  if (!profile) return config;
  return {
    ...config,
    profiles: {
      ...config.profiles,
      [profileName]: { ...profile, contextWindow: window, contextWindowProbed: true },
    },
  };
}

// A new profile built on `from` (an ad-hoc /model target) takes its connection settings but not
// a probed window: that number was measured for `from`'s model, and the new one gets its own probe.
export function inheritProfile(from: Profile, model: string): Profile {
  const { contextWindowProbed: _probed, ...rest } = from;
  return {
    ...rest,
    model,
    contextWindow: from.contextWindowProbed ? undefined : from.contextWindow,
    adhoc: true,
  };
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
