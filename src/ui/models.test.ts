import { describe, expect, it } from 'vitest';
import { buildModelTargets } from './models.js';
import type { Profile } from '../types.js';

const profile = (model: string, baseURL = 'http://localhost:11434/v1'): Profile => ({
  model,
  baseURL,
  apiKey: 'no-key',
  maxTokens: undefined,
  contextWindow: undefined,
  minGenTokens: 2048,
});

describe('buildModelTargets', () => {
  it('single model maps to the default profile', () => {
    const targets = buildModelTargets(
      { models: ['qwen2.5-coder:32b'], profiles: { default: profile('qwen2.5-coder:32b') } },
      'default',
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      name: 'default',
      model: 'qwen2.5-coder:32b',
      kind: 'model',
      active: true,
    });
  });

  it('multiple models switch by their lowercased names', () => {
    const models = ['Qwen2.5-Coder', 'GLM-4'];
    const targets = buildModelTargets(
      {
        models,
        profiles: {
          default: profile('Qwen2.5-Coder'),
          'qwen2.5-coder': profile('Qwen2.5-Coder'),
          'glm-4': profile('GLM-4'),
        },
      },
      'default',
    );
    expect(targets.map(t => t.name)).toEqual(['qwen2.5-coder', 'glm-4']);
    // First model is active while the profile is still 'default'.
    expect(targets.map(t => t.active)).toEqual([true, false]);
  });

  it('marks the selected model active once switched', () => {
    const targets = buildModelTargets(
      {
        models: ['A', 'B'],
        profiles: { default: profile('A'), a: profile('A'), b: profile('B') },
      },
      'b',
    );
    expect(targets.find(t => t.name === 'b')?.active).toBe(true);
    expect(targets.find(t => t.name === 'a')?.active).toBe(false);
  });

  it('appends named profiles, excluding default and model keys', () => {
    const targets = buildModelTargets(
      {
        models: ['local-model'],
        profiles: {
          default: profile('local-model'),
          big: profile('deepseek-chat', 'https://api.deepseek.com/v1'),
        },
      },
      'big',
    );
    expect(targets.map(t => t.name)).toEqual(['default', 'big']);
    expect(targets[1]).toMatchObject({
      kind: 'profile',
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      active: true,
    });
    expect(targets[0].active).toBe(false);
  });

  it('carries the adhoc flag for runtime-registered models', () => {
    const targets = buildModelTargets(
      {
        models: ['local-model'],
        profiles: {
          default: profile('local-model'),
          'foo-32b': { ...profile('Foo-32B'), adhoc: true },
        },
      },
      'foo-32b',
    );
    expect(targets.map(t => t.name)).toEqual(['default', 'foo-32b']);
    expect(targets[1]).toMatchObject({
      kind: 'profile',
      model: 'Foo-32B',
      adhoc: true,
      active: true,
    });
    expect(targets[0].adhoc).toBeUndefined();
  });

  it("carries the group for a named profile's extra model", () => {
    const targets = buildModelTargets(
      {
        models: ['local-model'],
        profiles: {
          default: profile('local-model'),
          go: profile('flash'),
          'muse-spark': { ...profile('Muse-Spark'), group: 'go' },
        },
      },
      'default',
    );
    expect(targets.map(t => t.name)).toEqual(['default', 'go', 'muse-spark']);
    expect(targets[2].group).toBe('go');
    expect(targets[1].group).toBeUndefined();
  });
});
