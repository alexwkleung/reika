import { describe, expect, it } from 'vitest';
import {
  MODE_BANNERS,
  MODE_CYCLE,
  modeSide,
  nextMode,
  resolveModeCommand,
  turnMode,
} from './modes.js';

describe('nextMode — Shift+Tab cycling', () => {
  it('cycles agent → plan → minimal → vibe → grind → chat → shell → agent', () => {
    expect(nextMode('agent')).toBe('plan');
    expect(nextMode('plan')).toBe('minimal');
    expect(nextMode('minimal')).toBe('vibe');
    expect(nextMode('vibe')).toBe('grind');
    expect(nextMode('grind')).toBe('chat');
    expect(nextMode('chat')).toBe('shell');
    expect(nextMode('shell')).toBe('agent');
  });

  it('visits every mode exactly once per lap', () => {
    const seen = new Set<string>();
    let m = MODE_CYCLE[0];
    for (let i = 0; i < MODE_CYCLE.length; i++) {
      seen.add(m);
      m = nextMode(m);
    }
    expect(m).toBe(MODE_CYCLE[0]);
    expect(seen.size).toBe(MODE_CYCLE.length);
  });
});

describe('turnMode — what a turn is recorded as', () => {
  it('records the mode the turn runs in', () => {
    expect(turnMode('agent', 'agent')).toBe('agent');
    expect(turnMode('plan', 'plan')).toBe('plan');
    expect(turnMode('chat', 'chat')).toBe('chat');
  });

  it('honours a one-turn override — /implement from plan mode is an agent turn', () => {
    expect(turnMode('plan', 'agent')).toBe('agent');
  });

  it('records both vibe phases as vibe, not as the plan/agent turns they run as', () => {
    expect(turnMode('vibe', 'plan')).toBe('vibe');
    expect(turnMode('vibe', 'agent')).toBe('vibe');
  });
});

describe('modeSide', () => {
  it('gives chat a side of its own and every other mode the shared one', () => {
    expect(modeSide('chat')).toBe('chat');
    for (const mode of MODE_CYCLE.filter(m => m !== 'chat')) {
      expect(modeSide(mode)).toBe('agent');
    }
  });
});

describe('resolveModeCommand', () => {
  it('is null for a command that names no mode', () => {
    expect(resolveModeCommand('help', { mode: 'agent', busy: false })).toBeNull();
    expect(resolveModeCommand('implement', { mode: 'plan', busy: false })).toBeNull();
  });

  it("switches to every mode with that mode's banner", () => {
    for (const to of MODE_CYCLE) {
      const from = to === 'agent' ? 'plan' : 'agent';
      expect(resolveModeCommand(to, { mode: from, busy: false })).toEqual({
        kind: 'switch',
        to,
        banner: MODE_BANNERS[to],
      });
    }
  });

  it("names the way back in every banner but agent's own", () => {
    for (const mode of MODE_CYCLE.filter(m => m !== 'agent' && m !== 'plan')) {
      expect(MODE_BANNERS[mode]).toContain('/agent to return');
    }
    expect(MODE_BANNERS.plan).toContain('/implement');
  });

  it('says so when the session is already in that mode, busy or not', () => {
    for (const busy of [false, true]) {
      expect(resolveModeCommand('plan', { mode: 'plan', busy })).toEqual({
        kind: 'refuse',
        content: 'Already in plan mode.',
      });
    }
  });

  it('refuses a switch while a turn is running', () => {
    expect(resolveModeCommand('chat', { mode: 'agent', busy: true })).toEqual({
      kind: 'refuse',
      content: 'Cannot switch modes while busy. Wait or ctrl-c to abort.',
    });
  });
});
