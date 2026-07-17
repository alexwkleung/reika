import type { Config } from '../types.js';

// One switchable entry for the /model picker and completion: the profile key
// `/model <name>` accepts, plus what it resolves to for display.
export type ModelTarget = {
  name: string;
  model: string;
  baseURL: string;
  kind: 'model' | 'profile';
  active: boolean;
};

// The switchable models/profiles, in the same order the old printed list used:
// models on the default base URL first, then named profiles. With a single
// model there is no auto-profile for it (see loadProfiles), so its switch
// target is 'default'.
export function buildModelTargets(
  config: Pick<Config, 'models' | 'profiles'>,
  activeProfile: string,
): ModelTarget[] {
  const modelKeys = config.models.map(m => m.toLowerCase());
  const targets: ModelTarget[] = config.models.map((m, i) => {
    const key = m.toLowerCase();
    const profile = config.profiles[key] ?? config.profiles.default;
    return {
      name: config.profiles[key] ? key : 'default',
      model: m,
      baseURL: profile.baseURL,
      kind: 'model' as const,
      active: activeProfile === key || (activeProfile === 'default' && i === 0),
    };
  });
  for (const [name, p] of Object.entries(config.profiles)) {
    if (name === 'default' || modelKeys.includes(name)) continue;
    targets.push({
      name,
      model: p.model,
      baseURL: p.baseURL,
      kind: 'profile',
      active: name === activeProfile,
    });
  }
  return targets;
}
