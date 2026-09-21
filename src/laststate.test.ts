import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types.js';
import { setAtLaunch } from './config.js';
import {
  loadLastState,
  persistableMode,
  saveLastState,
  startMode,
  startProfile,
} from './laststate.js';

const PROFILE = { model: 'm', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k' };
const CONFIG = {
  profiles: { default: PROFILE, kimi: { ...PROFILE, model: 'kimi-k2' } },
} as unknown as Config;

const none = (): boolean => false;
const only =
  (...names: string[]) =>
  (name: string): boolean =>
    names.includes(name);

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reika-laststate-'));
  file = join(dir, 'state.json');
  delete process.env.REIKA_DEFAULT_MODE;
  delete process.env.REIKA_PLAN_EXPERIMENT;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.REIKA_DEFAULT_MODE;
  delete process.env.REIKA_PLAN_EXPERIMENT;
});

describe('loadLastState', () => {
  it('is empty for a missing file', () => {
    expect(loadLastState(file)).toEqual({});
  });

  it('is empty for malformed JSON or a non-object', () => {
    writeFileSync(file, '{not json');
    expect(loadLastState(file)).toEqual({});
    writeFileSync(file, '"plan"');
    expect(loadLastState(file)).toEqual({});
  });

  it('drops a mode that is not a launchable one and a blank profile', () => {
    writeFileSync(file, JSON.stringify({ mode: 'chat', profile: '  ' }));
    expect(loadLastState(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ mode: 'shell', profile: 'kimi' }));
    expect(loadLastState(file)).toEqual({ profile: 'kimi' });
  });

  it('reads both fields', () => {
    writeFileSync(file, JSON.stringify({ mode: 'plan', profile: 'kimi' }));
    expect(loadLastState(file)).toEqual({ mode: 'plan', profile: 'kimi' });
  });
});

describe('saveLastState', () => {
  it('creates the directory and merges over what is on disk', () => {
    const nested = join(dir, 'a', 'b', 'state.json');
    saveLastState({ mode: 'plan' }, nested);
    saveLastState({ profile: 'kimi' }, nested);
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ mode: 'plan', profile: 'kimi' });
  });

  it('replaces a malformed file rather than failing', () => {
    writeFileSync(file, '{not json');
    saveLastState({ mode: 'vibe' }, file);
    expect(loadLastState(file)).toEqual({ mode: 'vibe' });
  });

  it('leaves no temp file behind', () => {
    saveLastState({ mode: 'agent' }, file);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    expect(() => readFileSync(`${file}.${process.pid}.tmp`)).toThrow();
  });

  it('is a no-op when the path cannot be written', () => {
    writeFileSync(join(dir, 'blocker'), '');
    expect(() =>
      saveLastState({ mode: 'agent' }, join(dir, 'blocker', 'state.json')),
    ).not.toThrow();
  });
});

describe('persistableMode', () => {
  it('keeps the launchable modes and drops chat/shell', () => {
    expect(persistableMode('agent')).toBe('agent');
    expect(persistableMode('plan')).toBe('plan');
    expect(persistableMode('vibe')).toBe('vibe');
    expect(persistableMode('minimal')).toBe('minimal');
    expect(persistableMode('chat')).toBeNull();
    expect(persistableMode('shell')).toBeNull();
  });
});

describe('startMode', () => {
  it('uses the saved mode over a .env default', () => {
    process.env.REIKA_DEFAULT_MODE = 'vibe';
    expect(startMode({ mode: 'plan' }, none)).toBe('plan');
  });

  it('falls back to the env default with nothing saved', () => {
    expect(startMode({}, none)).toBe('agent');
    process.env.REIKA_DEFAULT_MODE = 'vibe';
    expect(startMode({}, none)).toBe('vibe');
  });

  it('lets REIKA_DEFAULT_MODE given at launch beat the saved mode', () => {
    process.env.REIKA_DEFAULT_MODE = 'vibe';
    expect(startMode({ mode: 'plan' }, only('REIKA_DEFAULT_MODE'))).toBe('vibe');
  });

  it('treats REIKA_PLAN_EXPERIMENT at launch as the flag too', () => {
    process.env.REIKA_PLAN_EXPERIMENT = '1';
    expect(startMode({ mode: 'vibe' }, only('REIKA_PLAN_EXPERIMENT'))).toBe('plan');
  });
});

describe('startProfile', () => {
  it('restores a saved profile the config still has, case-insensitively', () => {
    expect(startProfile(CONFIG, { profile: 'kimi' }, none)).toBe('kimi');
    expect(startProfile(CONFIG, { profile: 'Kimi' }, none)).toBe('kimi');
  });

  it('falls back to default for nothing saved or a name the config lacks', () => {
    expect(startProfile(CONFIG, {}, none)).toBe('default');
    expect(startProfile(CONFIG, { profile: 'gone' }, none)).toBe('default');
  });

  it('lets REIKA_MODEL given at launch beat the saved profile', () => {
    expect(startProfile(CONFIG, { profile: 'kimi' }, only('REIKA_MODEL'))).toBe('default');
  });
});

describe('setAtLaunch', () => {
  it('sees keys present before dotenv ran and not ones set afterwards', () => {
    expect(setAtLaunch('PATH')).toBe(true);
    process.env.REIKA_LAST_STATE_TEST_KEY = '1';
    try {
      expect(setAtLaunch('REIKA_LAST_STATE_TEST_KEY')).toBe(false);
    } finally {
      delete process.env.REIKA_LAST_STATE_TEST_KEY;
    }
  });
});
