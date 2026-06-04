import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveProfile } from './config.js';

const ENV_KEYS = [
  'REIKA_MODEL',
  'REIKA_BASE_URL',
  'REIKA_API_KEY',
  'REIKA_MAX_TOKENS',
  'REIKA_CONTEXT_WINDOW',
  'REIKA_PROFILES',
  'REIKA_KIMI_MODEL',
  'REIKA_KIMI_BASE_URL',
  'REIKA_KIMI_API_KEY',
  'REIKA_KIMI_MAX_TOKENS',
  'REIKA_KIMI_CONTEXT_WINDOW',
  'REIKA_GPT4_MODEL',
  'REIKA_GPT4_BASE_URL',
  'REIKA_GPT4_API_KEY',
  'REIKA_GPT4_MAX_TOKENS',
  'REIKA_GPT4_CONTEXT_WINDOW',
  'REIKA_MINIMAL_MODEL',
  'REIKA_MINIMAL_CONTEXT_WINDOW',
  'REIKA_BROKEN_MODEL',
  'REIKA_BROKEN_BASE_URL',
  'REIKA_REASONING_ROUNDS',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('loadConfig — profiles', () => {
  it('always has a "default" profile from the flat REIKA_MODEL/BASE_URL/API_KEY', () => {
    process.env.REIKA_MODEL = 'qwen3-9b';
    process.env.REIKA_BASE_URL = 'http://localhost:8080/v1';
    process.env.REIKA_API_KEY = 'k';
    const cfg = loadConfig();
    expect(cfg.profiles.default).toEqual({
      model: 'qwen3-9b',
      baseURL: 'http://localhost:8080/v1',
      apiKey: 'k',
    });
  });

  it('loads named profiles from REIKA_PROFILES + per-profile env vars', () => {
    process.env.REIKA_MODEL = 'default-model';
    process.env.REIKA_PROFILES = 'kimi,gpt4';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_BASE_URL = 'https://moonshot.example/v1';
    process.env.REIKA_KIMI_API_KEY = 'kimi-key';
    process.env.REIKA_GPT4_MODEL = 'gpt-4o';
    process.env.REIKA_GPT4_BASE_URL = 'https://openai.example/v1';
    process.env.REIKA_GPT4_API_KEY = 'gpt-key';
    const cfg = loadConfig();
    expect(Object.keys(cfg.profiles).sort()).toEqual(['default', 'gpt4', 'kimi']);
    expect(cfg.profiles.kimi).toEqual({
      model: 'kimi-k2',
      baseURL: 'https://moonshot.example/v1',
      apiKey: 'kimi-key',
    });
  });

  it('skips named profiles that lack a MODEL env var', () => {
    process.env.REIKA_MODEL = 'default';
    process.env.REIKA_PROFILES = 'kimi,broken';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    // REIKA_BROKEN_MODEL deliberately unset
    const cfg = loadConfig();
    expect(Object.keys(cfg.profiles)).toContain('kimi');
    expect(Object.keys(cfg.profiles)).not.toContain('broken');
  });

  it('falls back to default base/key when a profile only sets MODEL', () => {
    process.env.REIKA_MODEL = 'default-m';
    process.env.REIKA_BASE_URL = 'http://default-base/v1';
    process.env.REIKA_API_KEY = 'default-key';
    process.env.REIKA_PROFILES = 'minimal';
    process.env.REIKA_MINIMAL_MODEL = 'minimal-m';
    const cfg = loadConfig();
    expect(cfg.profiles.minimal).toEqual({
      model: 'minimal-m',
      baseURL: 'http://default-base/v1',
      apiKey: 'default-key',
    });
  });

  it('normalizes profile names to lowercase', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_PROFILES = 'Kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    const cfg = loadConfig();
    expect(cfg.profiles.kimi).toBeDefined();
    expect(cfg.profiles.Kimi).toBeUndefined();
  });
});

describe('resolveProfile', () => {
  it('returns the config unchanged when the named profile is missing', () => {
    process.env.REIKA_MODEL = 'm';
    const cfg = loadConfig();
    const resolved = resolveProfile(cfg, 'nonexistent');
    expect(resolved.model).toBe(cfg.model);
    expect(resolved.baseURL).toBe(cfg.baseURL);
  });

  it('overlays the named profile onto config', () => {
    process.env.REIKA_MODEL = 'default-m';
    process.env.REIKA_BASE_URL = 'http://default/v1';
    process.env.REIKA_API_KEY = 'default-k';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_BASE_URL = 'https://moonshot/v1';
    process.env.REIKA_KIMI_API_KEY = 'kimi-k';
    const cfg = loadConfig();
    const resolved = resolveProfile(cfg, 'kimi');
    expect(resolved.model).toBe('kimi-k2');
    expect(resolved.baseURL).toBe('https://moonshot/v1');
    expect(resolved.apiKey).toBe('kimi-k');
    // Non-profile fields preserved
    expect(resolved.maxTurns).toBe(cfg.maxTurns);
  });
});

describe('base URL validation', () => {
  it('rejects REIKA_BASE_URL ending in /chat/completions', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
    expect(() => loadConfig()).toThrow(/REIKA_BASE_URL.*API root.*\/chat\/completions/);
  });

  it('rejects /chat/completions even with a trailing slash', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions/';
    expect(() => loadConfig()).toThrow(/REIKA_BASE_URL/);
  });

  it('rejects /completions (legacy endpoint)', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_BASE_URL = 'https://api.example.com/v1/completions';
    expect(() => loadConfig()).toThrow(/REIKA_BASE_URL/);
  });

  it('accepts a clean API root', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_BASE_URL = 'https://openrouter.ai/api/v1';
    expect(() => loadConfig()).not.toThrow();
  });

  it('validates per-profile base URLs too', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_PROFILES = 'broken';
    process.env.REIKA_BROKEN_MODEL = 'x';
    process.env.REIKA_BROKEN_BASE_URL = 'https://api.example.com/v1/chat/completions';
    expect(() => loadConfig()).toThrow(/REIKA_BROKEN_BASE_URL/);
  });
});

describe('maxTokens', () => {
  it('is undefined when REIKA_MAX_TOKENS is not set', () => {
    process.env.REIKA_MODEL = 'm';
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBeUndefined();
    expect(cfg.profiles.default.maxTokens).toBeUndefined();
  });

  it('reads REIKA_MAX_TOKENS into the default profile', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_MAX_TOKENS = '4096';
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBe(4096);
    expect(cfg.profiles.default.maxTokens).toBe(4096);
  });

  it('named profile inherits maxTokens from default when not overridden', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_MAX_TOKENS = '4096';
    process.env.REIKA_PROFILES = 'minimal';
    process.env.REIKA_MINIMAL_MODEL = 'mini';
    const cfg = loadConfig();
    expect(cfg.profiles.minimal.maxTokens).toBe(4096);
  });

  it('per-profile REIKA_<NAME>_MAX_TOKENS overrides the default', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_MAX_TOKENS = '4096';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_MAX_TOKENS = '16384';
    const cfg = loadConfig();
    expect(cfg.profiles.kimi.maxTokens).toBe(16384);
    expect(cfg.profiles.default.maxTokens).toBe(4096);
  });

  it('ignores invalid (non-numeric) values', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_MAX_TOKENS = 'abc';
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBeUndefined();
  });

  it('resolveProfile carries maxTokens through', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_MAX_TOKENS = '8192';
    const cfg = loadConfig();
    const resolved = resolveProfile(cfg, 'kimi');
    expect(resolved.maxTokens).toBe(8192);
  });
});

describe('contextWindow', () => {
  it('is undefined when REIKA_CONTEXT_WINDOW is not set', () => {
    process.env.REIKA_MODEL = 'm';
    const cfg = loadConfig();
    expect(cfg.contextWindow).toBeUndefined();
    expect(cfg.profiles.default.contextWindow).toBeUndefined();
  });

  it('reads REIKA_CONTEXT_WINDOW into the default profile', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_CONTEXT_WINDOW = '16384';
    const cfg = loadConfig();
    expect(cfg.contextWindow).toBe(16384);
    expect(cfg.profiles.default.contextWindow).toBe(16384);
  });

  it('named profile inherits contextWindow from default when not overridden', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_CONTEXT_WINDOW = '16384';
    process.env.REIKA_PROFILES = 'minimal';
    process.env.REIKA_MINIMAL_MODEL = 'mini';
    const cfg = loadConfig();
    expect(cfg.profiles.minimal.contextWindow).toBe(16384);
  });

  it('per-profile REIKA_<NAME>_CONTEXT_WINDOW overrides the default', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_CONTEXT_WINDOW = '16384';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_CONTEXT_WINDOW = '262144';
    const cfg = loadConfig();
    expect(cfg.profiles.kimi.contextWindow).toBe(262144);
    expect(cfg.profiles.default.contextWindow).toBe(16384);
  });

  it('resolveProfile carries contextWindow through', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_CONTEXT_WINDOW = '131072';
    const cfg = loadConfig();
    const resolved = resolveProfile(cfg, 'kimi');
    expect(resolved.contextWindow).toBe(131072);
  });
});

describe('reasoningRounds', () => {
  it('defaults to 2 when unset', () => {
    process.env.REIKA_MODEL = 'm';
    expect(loadConfig().reasoningRounds).toBe(2);
  });

  it('reads REIKA_REASONING_ROUNDS', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_REASONING_ROUNDS = '5';
    expect(loadConfig().reasoningRounds).toBe(5);
  });

  it('floors at 1 (the active round must keep its reasoning)', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_REASONING_ROUNDS = '0';
    expect(loadConfig().reasoningRounds).toBe(1);
  });
});
