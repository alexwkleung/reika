import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveDefaultMode, setAtLaunch } from './config.js';
import type { Config, DefaultMode, Mode } from './types.js';

// The last session's mode and profile (#365), so a restart lands where the user left off. A launch
// flag still wins — `REIKA_DEFAULT_MODE=plan reika` or `REIKA_MODEL=x reika` says what THIS session
// should be — while a .env value is only the default the saved state overrides.

export type LastState = { mode?: DefaultMode; profile?: string };

export const LAST_STATE_PATH = join(homedir(), '.config', 'reika', 'state.json');

const DEFAULT_MODES: readonly DefaultMode[] = ['agent', 'plan', 'vibe', 'minimal', 'grind'];

// Chat isolates its history and shell bypasses the model, so neither is a mode a session can open
// in (see DefaultMode) — switching to one leaves the last work mode on record instead.
export function persistableMode(mode: Mode): DefaultMode | null {
  return (DEFAULT_MODES as readonly string[]).includes(mode) ? (mode as DefaultMode) : null;
}

// Fail-open: a missing, unreadable or malformed file is an empty state, never an error at startup.
export function loadLastState(path = LAST_STATE_PATH): LastState {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const { mode, profile } = raw as Record<string, unknown>;
    const state: LastState = {};
    if (typeof mode === 'string' && (DEFAULT_MODES as readonly string[]).includes(mode)) {
      state.mode = mode as DefaultMode;
    }
    if (typeof profile === 'string' && profile.trim() !== '') state.profile = profile;
    return state;
  } catch {
    return {};
  }
}

// Merges `patch` over what is on disk. Written via a temp file + rename so a crash mid-write
// leaves the old state rather than half a document; a failed write is dropped silently — the
// session is unaffected, only the next launch's starting point.
export function saveLastState(patch: LastState, path = LAST_STATE_PATH): void {
  try {
    const next = { ...loadLastState(path), ...patch };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // fail-open
  }
}

// Launch flag > last session > .env default. REIKA_PLAN_EXPERIMENT counts as the flag too, since
// it is the legacy spelling of REIKA_DEFAULT_MODE=plan.
export function startMode(
  state: LastState,
  launched: (name: string) => boolean = setAtLaunch,
): Mode {
  if (launched('REIKA_DEFAULT_MODE') || launched('REIKA_PLAN_EXPERIMENT'))
    return resolveDefaultMode();
  return state.mode ?? resolveDefaultMode();
}

// Same order for the profile. A REIKA_MODEL given at launch redefines the default profile, which
// is then what the user asked for; a saved name the config no longer has (a removed profile, or an
// ad-hoc /model target that was never in .env) falls back to default rather than being recreated.
export function startProfile(
  config: Config,
  state: LastState,
  launched: (name: string) => boolean = setAtLaunch,
): string {
  if (launched('REIKA_MODEL')) return 'default';
  const name = state.profile?.toLowerCase();
  return name && config.profiles[name] ? name : 'default';
}
