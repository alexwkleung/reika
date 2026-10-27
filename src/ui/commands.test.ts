import { describe, expect, it } from 'vitest';
import {
  isImplementCommand,
  COMMANDS,
  MODE_CYCLE,
  buildImplementPrompt,
  buildSearchPrompt,
  isSaveCommand,
  nextMode,
  planWritten,
  searchModeRefusal,
  searchUnavailableNotice,
  turnMode,
} from './commands.js';
import type { Message } from '../types.js';

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

describe('COMMANDS — /implement', () => {
  it('is registered so it autocompletes and shows in suggestions', () => {
    const implement = COMMANDS.find(c => c.name === 'implement');
    expect(implement).toBeDefined();
    expect(implement?.desc).toMatch(/agent, minimal, or grind/i);
  });

  it('isImplementCommand matches the whole word, with or without guidance', () => {
    expect(isImplementCommand('/implement')).toBe(true);
    expect(isImplementCommand('  /implement keep it small ')).toBe(true);
    expect(isImplementCommand('/IMPLEMENT')).toBe(true);
    expect(isImplementCommand('/implementation-notes')).toBe(false);
    expect(isImplementCommand('implement the plan')).toBe(false);
  });
});

describe('COMMANDS — /vibe', () => {
  it('is registered so it autocompletes and shows in suggestions', () => {
    const vibe = COMMANDS.find(c => c.name === 'vibe');
    expect(vibe).toBeDefined();
    expect(vibe?.desc).toMatch(/plan/i);
  });
});

describe('planWritten', () => {
  it('finds the planFinal marker on an assistant message', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'add a flag' },
      { role: 'assistant', content: '1. Edit src/config.ts …', planFinal: true },
    ];
    expect(planWritten(msgs)).toBe(true);
  });

  it('is false for a turn with no finalized plan (e.g. aborted mid-exploration)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'add a flag' },
      { role: 'assistant', content: '(aborted)' },
    ];
    expect(planWritten(msgs)).toBe(false);
  });

  it('ignores plan-looking text that lacks the marker — the signal is the harness stamp, not content', () => {
    const msgs: Message[] = [{ role: 'assistant', content: '1. Edit src/config.ts\n2. Run tests' }];
    expect(planWritten(msgs)).toBe(false);
  });

  // #126: the marker means the plan TURN ended, not that a plan came out of it — loop.ts stamps it
  // on any final plan-mode message, force-written spirals included. Vibe chained edits off those.
  it('is false when the marked message has no steps in it (a force-written spiral)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'fix the thing' },
      {
        role: 'assistant',
        content:
          'I could not determine which file handles this. I looked at several candidates but ' +
          'none of them clearly own the behavior you described.',
        planFinal: true,
      },
    ];
    expect(planWritten(msgs)).toBe(false);
  });

  it('accepts a step that names no file — a plan need not quote paths to be a plan', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '1. Rename the exported helper\n2. Update its callers',
        planFinal: true,
      },
    ];
    expect(planWritten(msgs)).toBe(true);
  });
});

describe('buildImplementPrompt', () => {
  it('points the model at the plan already in history', () => {
    const prompt = buildImplementPrompt('');
    // "the plan above" is load-bearing: the plan sits verbatim in history (handoff distillation),
    // so the prompt only references it rather than restating intent.
    expect(prompt).toContain('plan above');
    expect(prompt).toContain('step by step');
  });

  it('omits the guidance section when there are no args', () => {
    expect(buildImplementPrompt('')).not.toContain('Additional guidance');
  });

  it('treats whitespace-only args as no args', () => {
    expect(buildImplementPrompt('   ')).toBe(buildImplementPrompt(''));
  });

  it('appends trailing args as explicit additional guidance', () => {
    const prompt = buildImplementPrompt('focus on the error paths first');
    expect(prompt).toContain('Additional guidance: focus on the error paths first');
    // The base instruction is preserved ahead of the guidance.
    expect(prompt.indexOf('plan above')).toBeLessThan(prompt.indexOf('Additional guidance'));
  });

  it('trims surrounding whitespace from the guidance', () => {
    expect(buildImplementPrompt('  do X  ')).toContain('Additional guidance: do X');
  });
});

describe('isSaveCommand', () => {
  it('matches /save with or without --raw, ignoring case and padding', () => {
    expect(isSaveCommand('/save')).toBe(true);
    expect(isSaveCommand('/save --raw')).toBe(true);
    expect(isSaveCommand('  /SAVE ')).toBe(true);
  });

  it('is a whole-word match — a longer command or a skill sharing the prefix still queues', () => {
    expect(isSaveCommand('/saved')).toBe(false);
    expect(isSaveCommand('/save-notes')).toBe(false);
    expect(isSaveCommand('save')).toBe(false);
    expect(isSaveCommand('')).toBe(false);
  });
});

// /search (#829). The command is the user taking the decision away from the model, so what it sends
// has to be binding enough that a small model uses `search` rather than answering from memory — but
// only where the session actually has the tool, which is what the two refusals are for.
describe('COMMANDS — /search', () => {
  it('is registered so it autocompletes and shows in suggestions', () => {
    const search = COMMANDS.find(c => c.name === 'search');
    expect(search).toBeDefined();
    expect(search?.desc).toMatch(/search provider/i);
  });

  it('sends instructions, not a bare query: the first action is the search call', () => {
    const prompt = buildSearchPrompt('react useState');
    expect(prompt).toContain('react useState');
    expect(prompt).toMatch(/first action is a `search` tool call/);
    // The two disciplines worth pinning: don't answer from memory, and don't invent a result set.
    expect(prompt).toMatch(/not from memory/);
    expect(prompt).toMatch(/instead of answering from memory/);
    // The query leads, so the mode's own prefix cannot bury what was asked.
    expect(prompt.startsWith('Search the web for: react useState')).toBe(true);
  });

  it('trims the query and keeps it on its own line', () => {
    expect(buildSearchPrompt('  spaced query  ')).toContain('Search the web for: spaced query\n');
  });

  it('refuses in the two modes whose tool lists carry no web tools', () => {
    // Shell has no model turn at all; minimal is bash-only (tools/index.ts minimalTools).
    expect(searchModeRefusal('shell')).toMatch(/shell mode/);
    expect(searchModeRefusal('minimal')).toMatch(/minimal mode/);
    // Every mode that does carry the pair passes, including vibe, whose submit is an agent turn.
    for (const mode of ['agent', 'plan', 'vibe', 'chat', 'grind'] as const) {
      expect(searchModeRefusal(mode)).toBeUndefined();
    }
  });

  it('names a different fix for offline than for an unconfigured provider', () => {
    // The two causes are not interchangeable: one is "no route out", the other is a switch to set.
    expect(searchUnavailableNotice(true)).toMatch(/no route out/);
    expect(searchUnavailableNotice(false)).toMatch(/REIKA_SEARXNG_URL/);
    expect(searchUnavailableNotice(false)).toMatch(/REIKA_CDP_SEARCH/);
  });
});
