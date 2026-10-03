import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AutoApproveMode,
  CdpSearchMode,
  Config,
  DefaultMode,
  Mode,
  ModelMode,
  PasteFetchMode,
  Profile,
  SkillAutoMode,
  VisionRoute,
} from './types.js';
import { DEFAULT_MIN_GEN_TOKENS } from './provider/budget.js';
import { parseMcpServers } from './mcp/config.js';

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
  const explicitMinGen = parseIntOrUndef(process.env.REIKA_MIN_GEN_TOKENS);
  const minGenTokens = Math.max(256, explicitMinGen ?? DEFAULT_MIN_GEN_TOKENS);
  // Unset, the reserve is learned from the session with the default as its floor (#551).
  const minGenAdaptive = explicitMinGen == null;
  const visionBaseURL = emptyToUndefined(process.env.REIKA_VISION_BASE_URL);
  if (visionBaseURL) validateBaseURL(visionBaseURL, 'REIKA_VISION_BASE_URL');
  // The default profile's route. Profiles read it as their own fallback, so a per-profile
  // REIKA_<NAME>_VISION overrides it and everything else inherits it — the same shape as the
  // connection settings above.
  const vision = parseVision(process.env.REIKA_VISION);
  const defaultProfile: Profile = {
    model,
    baseURL,
    apiKey,
    maxTokens,
    contextWindow,
    minGenTokens,
    minGenAdaptive,
    vision,
  };
  // Named once: the per-mode map (#616) resolves its entries against the same set.
  const profiles = loadProfiles(defaultProfile, models);
  return {
    baseURL,
    apiKey,
    model,
    models,
    maxTokens,
    contextWindow,
    minGenTokens,
    minGenAdaptive,
    // A termination backstop for the spiral shapes the loop detectors miss, not a cost cap: a
    // cached round is nearly free on both local and API, so it is sized where a healthy complex
    // turn never lands and a spiral in headless (no ctrl-c) still ends in hours, not days.
    maxTurns: parseInt(process.env.REIKA_MAX_TURNS ?? '200', 10),
    repoMapBudget: parseInt(process.env.REIKA_REPO_MAP_BUDGET ?? '3200', 10),
    autoApprove: parseAutoApprove(process.env.REIKA_AUTO_APPROVE),
    autoApproveExplicit: (process.env.REIKA_AUTO_APPROVE ?? '').trim() !== '',
    unattended: process.env.REIKA_UNATTENDED === '1',
    subagentModel: emptyToUndefined(process.env.REIKA_SUBAGENT_MODEL),
    subagentBaseURL: emptyToUndefined(process.env.REIKA_SUBAGENT_BASE_URL),
    subagentApiKey: emptyToUndefined(process.env.REIKA_SUBAGENT_API_KEY),
    // Not a backstop: the last round IS the report round (#340), so this stays tight.
    subagentMaxTurns: parseInt(process.env.REIKA_SUBAGENT_MAX_TURNS ?? '8', 10),
    visionModel: emptyToUndefined(process.env.REIKA_VISION_MODEL),
    visionBaseURL,
    visionApiKey: emptyToUndefined(process.env.REIKA_VISION_API_KEY),
    vision,
    searxngUrl: emptyToUndefined(process.env.REIKA_SEARXNG_URL),
    cdpSearch: parseCdpSearch(process.env.REIKA_CDP_SEARCH),
    cdpPort: parseIntOrUndef(process.env.REIKA_CDP_PORT),
    profiles,
    ...parseModeModels(process.env.REIKA_MODE_MODELS, profiles, models),
    maxSearchesPerTurn: parseInt(process.env.REIKA_MAX_SEARCHES_PER_TURN ?? '3', 10),
    maxFetchesPerTurn: parseInt(process.env.REIKA_MAX_FETCHES_PER_TURN ?? '5', 10),
    bashTimeoutMs: parseInt(process.env.REIKA_BASH_TIMEOUT_MS ?? '1800000', 10),
    bashIdleMs: parseInt(process.env.REIKA_BASH_IDLE_MS ?? '300000', 10),
    // Floor at 1 so the active tool-call round always keeps its reasoning (required for
    // the reasoning roundtrip on providers that validate it).
    reasoningRounds: Math.max(1, parseIntOrUndef(process.env.REIKA_REASONING_ROUNDS) ?? 2),
    ocrLangs: parseList(process.env.REIKA_OCR_LANGS),
    pasteFetch: parsePasteFetch(process.env.REIKA_PASTE_FETCH),
    // On by default, and only macOS has an implementation (#163) — see tools/_sandbox.ts. A flag
    // rather than a hardcoded path because the sandbox changes what a command may do, so a run that
    // is measuring anything about bash behavior needs a way to get the old world back.
    sandbox: process.env.REIKA_SANDBOX !== '0',
    // Post-edit typecheck gate (#300), on by default. `0` disables the whole feature — the
    // baseline capture, the per-edit checks, and the done-gate — for projects that verify types
    // their own way or find tsc too slow to run twice per turn. See check/typecheck.ts.
    typecheck: process.env.REIKA_TYPECHECK !== '0',
    // Per-project session auto-save for /resume (#1). Default on; `0` stops reika writing
    // conversations to disk at all, which is the one reason to want it off.
    autosave: process.env.REIKA_AUTOSAVE !== '0',
    // Rotating garden words on the busy indicator (#500). Default on; `0` keeps the plain
    // "Working…" for anyone who finds it noise.
    workingWords: process.env.REIKA_WORKING_WORDS !== '0',
    skillAuto: parseSkillAuto(process.env.REIKA_SKILL_AUTO),
    // MCP servers (#265). Off unless configured: `REIKA_MCP_SERVERS` carries the JSON (or a path to
    // a JSON file), and `REIKA_MCP=0` is the one switch that turns a configured set off — the
    // polarity `REIKA_ASK` uses, and the arm a session measuring behavior without MCP needs.
    ...(process.env.REIKA_MCP === '0'
      ? { mcpServers: [], mcpErrors: [] }
      : mcpConfig(process.env.REIKA_MCP_SERVERS)),
    // Substitute the current user's git name/email and account slugs for <user>/<email> in the
    // scrollback and saved transcripts. Off by default: normally you want to see your own handle,
    // and the lookup costs three git subprocesses at startup that are pure waste when unused.
    anon: process.env.REIKA_ANON === '1',
  };
}

// The parsed servers plus the parse errors, under the two Config field names the session reads.
// The env value is read at the call site so this stays a pure function of it.
function mcpConfig(raw: string | undefined): {
  mcpServers: Config['mcpServers'];
  mcpErrors: string[];
} {
  const { servers, errors } = parseMcpServers(raw);
  return { mcpServers: servers, mcpErrors: errors };
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
      minGenAdaptive: profileMinGen ? false : defaultProfile.minGenAdaptive,
      vision: parseVision(process.env[`REIKA_${upper}_VISION`]) ?? defaultProfile.vision,
    };
    for (const m of profileModels.slice(1)) {
      const key = m.toLowerCase();
      if (key === 'default' || profiles[key]) continue;
      profiles[key] = { ...profiles[lower], model: m, group: lower };
    }
  }
  return profiles;
}

// Per-mode models (#616). REIKA_MODE_MODELS=plan=kimi,grind=qwen3-coder says which model each mode
// runs on, so a session can plan on the big model and grind on the careful one without a /model
// switch at every mode change (and without a launch env that only covers the mode it names).
//
// One key listing pairs, rather than REIKA_PLAN_MODEL / REIKA_GRIND_MODEL: that spelling is
// already taken. REIKA_<NAME>_MODEL defines the profile NAME, and `minimal` — a mode name — is
// exactly the sort of thing a user names a profile, so a per-mode key would silently be read as
// both. Pairs also fail loud: a name that is neither a mode nor a model the config has is reported
// rather than half-applied.
//
// A value is what `/model <name>` accepts: a profile, or one of REIKA_MODEL's models, which lands
// on the profile that serves it ('default' when a single model is listed, since only then is there
// no auto-profile of its own — see loadProfiles). An entry that names neither is dropped: an
// unknown name is far more likely a typo than a model, and resolving it ad-hoc the way a typed
// `/model x` does would send a whole mode's turns to a name no server serves.
function parseModeModels(
  raw: string | undefined,
  profiles: Record<string, Profile>,
  models: string[],
): Pick<Config, 'modeProfiles' | 'modeModelErrors'> {
  const modeProfiles: Partial<Record<ModelMode, string>> = {};
  const modeModelErrors: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const text = entry.trim();
    if (text === '') continue;
    const at = text.indexOf('=');
    const mode = (at === -1 ? '' : text.slice(0, at)).trim().toLowerCase();
    const name = at === -1 ? '' : text.slice(at + 1).trim();
    if (name === '' || !isModelMode(mode)) {
      modeModelErrors.push(
        `REIKA_MODE_MODELS: ignoring '${text}' — expected <mode>=<profile|model> for ${MODEL_MODES.join(', ')}.`,
      );
      continue;
    }
    const key = name.toLowerCase();
    // A registered profile, or one of REIKA_MODEL's models on the profile that serves it.
    let profile: string | undefined;
    if (profiles[key]) profile = key;
    else if (models.some(m => m.toLowerCase() === key)) profile = 'default';
    if (!profile) {
      modeModelErrors.push(
        `REIKA_MODE_MODELS: ignoring '${text}' — no profile or model named '${name}' in your config.`,
      );
      continue;
    }
    modeProfiles[mode] = profile;
  }
  return { modeProfiles, modeModelErrors };
}

// The modes whose turns reach the model. Shell runs the command itself, so it has no model to
// choose — see ModelMode.
export const MODEL_MODES: readonly ModelMode[] = [
  'agent',
  'plan',
  'vibe',
  'minimal',
  'grind',
  'chat',
];

export function isModelMode(mode: string): mode is ModelMode {
  return (MODEL_MODES as readonly string[]).includes(mode);
}

// The profile a mode switch lands on (#616). A mode with its own model runs that; a mode without
// one comes back to the session's own profile, because the map OVERRIDES that profile rather than
// replacing it — otherwise one mapping would strand the session on its model for good, and a
// two-way switch (plan → agent) is the whole point. Undefined means "leave the model alone": shell
// reaches no model, and the caller's own /model check keeps a hand-picked model for the session.
export function modeSwitchProfile(
  config: Pick<Config, 'modeProfiles'>,
  mode: Mode,
  sessionProfile: string,
): string | undefined {
  if (!isModelMode(mode)) return undefined;
  return config.modeProfiles?.[mode] ?? sessionProfile;
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

// REIKA_CDP_SEARCH. Unset is 'auto' (see CdpSearchMode). Anything unrecognized is 'off', the
// polarity parseSkillAuto uses: a typo should not be what starts a browser.
function parseCdpSearch(raw: string | undefined): CdpSearchMode {
  switch ((raw ?? '').trim().toLowerCase()) {
    case '':
    case 'auto':
      return 'auto';
    case '1':
    case 'true':
    case 'on':
      return 'on';
    default:
      return 'off';
  }
}

// REIKA_VISION (and per-profile REIKA_<NAME>_VISION) picks how a pasted image reaches the model:
// 'describe' (default) reads it into text first, 'native' hands the bytes to the model itself. An
// unrecognized value falls back to undefined — meaning "inherit", which lands on 'describe', the
// route that works for every model. A typo must not silently start sending bytes a text-only model
// will choke on, so the safe direction here is the same as the unrecognized-skill-auto one.
function parseVision(raw: string | undefined): VisionRoute | undefined {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'describe':
    case 'ocr':
      return 'describe';
    case 'native':
      return 'native';
    default:
      return undefined;
  }
}

// REIKA_PASTE_FETCH, the same shape as REIKA_SKILL_AUTO (#448). '1'/'true' map to 'apply' because
// before the shape gate they meant "fetch every pasted URL", which is what 'apply' still does
// headless. Anything unrecognized is 'off': a typo should cost a fetch, not cause one.
function parsePasteFetch(raw: string | undefined): PasteFetchMode {
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

// REIKA_DEFAULT_MODE picks the mode a session starts in: 'agent' (default), 'plan', 'vibe',
// 'minimal', or 'grind'.
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
    case 'grind':
      return 'grind';
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

// Records what the endpoint or the catalog reported (#417) on one profile. The profile only —
// never the top-level `contextWindow`, which every profile reads as its fallback and which would
// hand the default model's window to a different model on a /model switch. A configured value is
// never overwritten: the env is the override.
export function withProbedLimits(
  config: Config,
  profileName: string,
  limits: { window?: number; maxOutput?: number },
): Config {
  const profile = config.profiles[profileName];
  if (!profile) return config;
  const next: Profile = { ...profile };
  if (limits.window && profile.contextWindow == null) {
    next.contextWindow = limits.window;
    next.contextWindowProbed = true;
  }
  if (limits.maxOutput && profile.maxOutputTokens == null) next.maxOutputTokens = limits.maxOutput;
  return { ...config, profiles: { ...config.profiles, [profileName]: next } };
}

// A new profile built on `from` (an ad-hoc /model target) takes its connection settings but not
// probed limits: those were measured for `from`'s model, and the new one gets its own probe.
export function inheritProfile(from: Profile, model: string): Profile {
  const { contextWindowProbed: _probed, maxOutputTokens: _maxOutput, ...rest } = from;
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
    maxOutputTokens: profile.maxOutputTokens,
    minGenTokens: profile.minGenTokens ?? config.minGenTokens,
    minGenAdaptive: profile.minGenTokens != null ? profile.minGenAdaptive : config.minGenAdaptive,
    // Same `?? config.x` fallback shape as minGenTokens. Without this line the profile's route is
    // dead weight: `...config` above would carry the *default* profile's value straight over it, so
    // a `/model <vl>` switch would keep describing while claiming to be native.
    vision: profile.vision ?? config.vision,
  };
}
