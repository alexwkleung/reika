import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveDefaultMode, resolveProfile } from './config.js';

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
  'REIKA_MIN_GEN_TOKENS',
  'REIKA_KIMI_MIN_GEN_TOKENS',
  'REIKA_GPT4_MIN_GEN_TOKENS',
  'REIKA_MINIMAL_MIN_GEN_TOKENS',
  'REIKA_DEFAULT_MODE',
  'REIKA_PLAN_EXPERIMENT',
  'REIKA_AUTO_APPROVE',
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

describe('loadConfig — base URL', () => {
  // Nothing else exercises the fallback: every other test sets REIKA_BASE_URL explicitly, which
  // is how the default sat at Ollama's 11434 while .env.example, the quick start and the README
  // all said llama-server's 8080. Pinned so the two can't drift apart again silently.
  it('falls back to llama-server on 8080 when REIKA_BASE_URL is unset', () => {
    process.env.REIKA_MODEL = 'qwen3-9b';
    delete process.env.REIKA_BASE_URL;
    expect(loadConfig().baseURL).toBe('http://localhost:8080/v1');
  });

  it('prefers an explicit REIKA_BASE_URL over the fallback', () => {
    process.env.REIKA_MODEL = 'qwen3-9b';
    process.env.REIKA_BASE_URL = 'https://api.example/v1';
    expect(loadConfig().baseURL).toBe('https://api.example/v1');
  });
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
      minGenTokens: 2048,
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
      minGenTokens: 2048,
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
      minGenTokens: 2048,
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

describe('loadConfig — multi-model REIKA_MODEL', () => {
  it('parses a comma-separated list; first model is the default', () => {
    process.env.REIKA_MODEL = 'a,b,c';
    process.env.REIKA_BASE_URL = 'http://router/v1';
    process.env.REIKA_API_KEY = 'k';
    const cfg = loadConfig();
    expect(cfg.model).toBe('a');
    expect(cfg.models).toEqual(['a', 'b', 'c']);
  });

  it('registers each extra model as an auto-profile inheriting the default base/key', () => {
    process.env.REIKA_MODEL = 'a,b,c';
    process.env.REIKA_BASE_URL = 'http://router/v1';
    process.env.REIKA_API_KEY = 'k';
    const cfg = loadConfig();
    expect(Object.keys(cfg.profiles).sort()).toEqual(['a', 'b', 'c', 'default']);
    expect(cfg.profiles.b).toEqual({
      model: 'b',
      baseURL: 'http://router/v1',
      apiKey: 'k',
      minGenTokens: 2048,
    });
  });

  it('trims whitespace and drops empty entries', () => {
    process.env.REIKA_MODEL = ' a , b ,, ';
    const cfg = loadConfig();
    expect(cfg.models).toEqual(['a', 'b']);
  });

  it('lowercases auto-profile keys so /model matches a lowercased target', () => {
    process.env.REIKA_MODEL = 'Qwen3-Coder,Kimi-K2';
    const cfg = loadConfig();
    expect(cfg.profiles['kimi-k2']).toBeDefined();
    expect(cfg.profiles['kimi-k2'].model).toBe('Kimi-K2');
  });

  it('resolveProfile swaps only the model, preserving base/key', () => {
    process.env.REIKA_MODEL = 'a,b';
    process.env.REIKA_BASE_URL = 'http://router/v1';
    process.env.REIKA_API_KEY = 'k';
    const cfg = loadConfig();
    const resolved = resolveProfile(cfg, 'b');
    expect(resolved.model).toBe('b');
    expect(resolved.baseURL).toBe('http://router/v1');
    expect(resolved.apiKey).toBe('k');
  });

  it('a single model registers no model-named profile (back-compat)', () => {
    process.env.REIKA_MODEL = 'm';
    const cfg = loadConfig();
    expect(cfg.models).toEqual(['m']);
    expect(Object.keys(cfg.profiles)).toEqual(['default']);
  });

  it('an explicit named profile wins over an auto-model of the same name', () => {
    process.env.REIKA_MODEL = 'a,kimi';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_BASE_URL = 'https://moonshot.example/v1';
    const cfg = loadConfig();
    expect(cfg.profiles.kimi.model).toBe('kimi-k2');
    expect(cfg.profiles.kimi.baseURL).toBe('https://moonshot.example/v1');
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

describe('minGenTokens', () => {
  it('defaults to 2048 when unset', () => {
    process.env.REIKA_MODEL = 'm';
    expect(loadConfig().minGenTokens).toBe(2048);
    expect(loadConfig().profiles.default.minGenTokens).toBe(2048);
  });

  it('reads REIKA_MIN_GEN_TOKENS', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_MIN_GEN_TOKENS = '6144';
    expect(loadConfig().minGenTokens).toBe(6144);
  });

  it('floors at 256 against a starving misconfiguration', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_MIN_GEN_TOKENS = '16';
    expect(loadConfig().minGenTokens).toBe(256);
  });

  it('per-profile REIKA_<NAME>_MIN_GEN_TOKENS overrides the default', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_MIN_GEN_TOKENS = '2048';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_MIN_GEN_TOKENS = '8192';
    const cfg = loadConfig();
    expect(cfg.profiles.kimi.minGenTokens).toBe(8192);
    expect(cfg.profiles.default.minGenTokens).toBe(2048);
  });

  it('resolveProfile carries minGenTokens through', () => {
    process.env.REIKA_MODEL = 'm';
    process.env.REIKA_PROFILES = 'kimi';
    process.env.REIKA_KIMI_MODEL = 'kimi-k2';
    process.env.REIKA_KIMI_MIN_GEN_TOKENS = '6144';
    const cfg = loadConfig();
    expect(resolveProfile(cfg, 'kimi').minGenTokens).toBe(6144);
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

describe('resolveDefaultMode', () => {
  it('defaults to agent when unset', () => {
    expect(resolveDefaultMode()).toBe('agent');
  });

  it('reads agent, plan, and vibe, case- and whitespace-insensitively', () => {
    process.env.REIKA_DEFAULT_MODE = 'plan';
    expect(resolveDefaultMode()).toBe('plan');
    process.env.REIKA_DEFAULT_MODE = ' Vibe ';
    expect(resolveDefaultMode()).toBe('vibe');
    process.env.REIKA_DEFAULT_MODE = 'AGENT';
    expect(resolveDefaultMode()).toBe('agent');
  });

  it('falls back to agent on an unrecognized value', () => {
    process.env.REIKA_DEFAULT_MODE = 'yolo';
    expect(resolveDefaultMode()).toBe('agent');
  });

  it('excludes chat and shell — not launchable modes', () => {
    process.env.REIKA_DEFAULT_MODE = 'chat';
    expect(resolveDefaultMode()).toBe('agent');
    process.env.REIKA_DEFAULT_MODE = 'shell';
    expect(resolveDefaultMode()).toBe('agent');
  });

  it('treats REIKA_PLAN_EXPERIMENT=1 as the legacy alias for plan', () => {
    process.env.REIKA_PLAN_EXPERIMENT = '1';
    expect(resolveDefaultMode()).toBe('plan');
  });

  it('lets an explicit REIKA_DEFAULT_MODE beat REIKA_PLAN_EXPERIMENT', () => {
    process.env.REIKA_PLAN_EXPERIMENT = '1';
    process.env.REIKA_DEFAULT_MODE = 'vibe';
    expect(resolveDefaultMode()).toBe('vibe');
    process.env.REIKA_DEFAULT_MODE = 'agent';
    expect(resolveDefaultMode()).toBe('agent');
  });
});

describe('loadConfig — auto-approve', () => {
  beforeEach(() => {
    process.env.REIKA_MODEL = 'm';
  });

  it('unset is safe, and not explicit — so the session toggle can still turn it off', () => {
    const c = loadConfig();
    expect(c.autoApprove).toBe('safe');
    expect(c.autoApproveExplicit).toBe(false);
  });

  it('an explicit safe/true/1 is safe and explicit', () => {
    for (const v of ['safe', 'true', '1', ' TRUE ']) {
      process.env.REIKA_AUTO_APPROVE = v;
      const c = loadConfig();
      expect(c.autoApprove, v).toBe('safe');
      expect(c.autoApproveExplicit, v).toBe(true);
    }
  });

  it('bypass/yolo is bypass', () => {
    for (const v of ['bypass', 'yolo']) {
      process.env.REIKA_AUTO_APPROVE = v;
      expect(loadConfig().autoApprove, v).toBe('bypass');
    }
  });

  it('an explicit off/false/0 turns the default off', () => {
    for (const v of ['off', 'false', '0']) {
      process.env.REIKA_AUTO_APPROVE = v;
      const c = loadConfig();
      expect(c.autoApprove, v).toBe('off');
      expect(c.autoApproveExplicit, v).toBe(true);
    }
  });

  it('an unrecognized value is off, not the default — a typo costs prompts, not safety', () => {
    process.env.REIKA_AUTO_APPROVE = 'sfae';
    expect(loadConfig().autoApprove).toBe('off');
  });

  it('a blank value reads as unset', () => {
    process.env.REIKA_AUTO_APPROVE = '  ';
    const c = loadConfig();
    expect(c.autoApprove).toBe('safe');
    expect(c.autoApproveExplicit).toBe(false);
  });
});
