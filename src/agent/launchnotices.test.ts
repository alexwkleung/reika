import { describe, expect, it } from 'vitest';
import { buildLaunchNotices, type LaunchFacts } from './launchnotices.js';
import type { Config, Mode } from '../types.js';

const quiet: LaunchFacts = { model: 'local', offline: false, mcpNotices: [] };

function notices(
  facts: Partial<LaunchFacts> = {},
  opts: {
    config?: Pick<Config, 'modeModelErrors' | 'projectEnvNotice'>;
    mode?: Mode;
    defaultMode?: Mode;
    profile?: string;
  } = {},
) {
  return buildLaunchNotices({
    facts: { ...quiet, ...facts },
    config: opts.config ?? {},
    mode: opts.mode ?? 'agent',
    defaultMode: opts.defaultMode ?? 'agent',
    profile: opts.profile ?? 'default',
  });
}

const OFFLINE =
  'No network — search and fetch_url tools are off for this session. Restart Reika once you are back online to get them back.';

describe('buildLaunchNotices', () => {
  it('says nothing when there is nothing to say', () => {
    expect(notices()).toEqual([]);
  });

  it('prints each notice with its own tone, none of them auto-saved', () => {
    expect(notices({ limitsNotice: 'limits' })).toEqual([
      { role: 'system', content: 'limits', skipAutosave: true },
    ]);
    expect(notices({ windowNotice: 'window' })).toEqual([
      { role: 'system', content: 'window', tone: 'warn', skipAutosave: true },
    ]);
    expect(notices({ budgetWarning: 'budget' })).toEqual([
      { role: 'system', content: 'budget', tone: 'warn', skipAutosave: true },
    ]);
    expect(notices({ offline: true })).toEqual([
      { role: 'system', content: OFFLINE, tone: 'warn', skipAutosave: true },
    ]);
    expect(notices({ searchNotice: 'search' })).toEqual([
      { role: 'system', content: 'search', tone: 'info', skipAutosave: true },
    ]);
    expect(notices({}, { config: { modeModelErrors: ['bad a', 'bad b'] } })).toEqual([
      { role: 'system', content: 'bad a', tone: 'warn', skipAutosave: true },
      { role: 'system', content: 'bad b', tone: 'warn', skipAutosave: true },
    ]);
    expect(notices({}, { config: { projectEnvNotice: 'env' } })).toEqual([
      { role: 'system', content: 'env', tone: 'warn', skipAutosave: true },
    ]);
  });

  it('reads the healthy MCP summary as good news and anything else as a warning', () => {
    expect(
      notices({ mcpNotices: ['MCP: 2 servers, 5 tools', 'REIKA_MCP_SERVERS: bad JSON'] }),
    ).toEqual([
      { role: 'system', content: 'MCP: 2 servers, 5 tools', tone: 'info', skipAutosave: true },
      {
        role: 'system',
        content: 'REIKA_MCP_SERVERS: bad JSON',
        tone: 'warn',
        skipAutosave: true,
      },
    ]);
  });

  it('keeps the documented order', () => {
    const all = notices(
      {
        model: 'big',
        limitsNotice: 'limits',
        windowNotice: 'window',
        budgetWarning: 'budget',
        offline: true,
        searchNotice: 'search',
        mcpNotices: ['MCP: ok'],
      },
      {
        config: { modeModelErrors: ['mode-models'], projectEnvNotice: 'env' },
        mode: 'plan',
        profile: 'kimi',
      },
    );
    expect(all.map(m => (m as { content: string }).content)).toEqual([
      "Resumed plan mode and profile 'kimi' (big) from the last session.",
      'limits',
      'window',
      'budget',
      OFFLINE,
      'search',
      'mode-models',
      'env',
      'MCP: ok',
    ]);
  });

  describe('the resumed line', () => {
    it('names a mode the env would not have started in', () => {
      expect(notices({}, { mode: 'plan', defaultMode: 'agent' })).toEqual([
        {
          role: 'system',
          content: 'Resumed plan mode from the last session.',
          skipAutosave: true,
        },
      ]);
    });

    it('names a profile other than the default, with its model', () => {
      expect(notices({ model: 'kimi-k3' }, { profile: 'kimi' })).toEqual([
        {
          role: 'system',
          content: "Resumed profile 'kimi' (kimi-k3) from the last session.",
          skipAutosave: true,
        },
      ]);
    });

    it('names both', () => {
      expect(notices({ model: 'kimi-k3' }, { mode: 'vibe', profile: 'kimi' })[0]).toMatchObject({
        content: "Resumed vibe mode and profile 'kimi' (kimi-k3) from the last session.",
      });
    });

    it('is absent where the env alone would have put the session', () => {
      expect(notices({}, { mode: 'plan', defaultMode: 'plan', profile: 'default' })).toEqual([]);
    });
  });
});
