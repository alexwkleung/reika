import { describe, expect, it } from 'vitest';
import {
  buildImplementPrompt,
  buildSearchPrompt,
  parseCommand,
  resolveSkillCommand,
  resolveTurnCommand,
  searchModeRefusal,
  searchUnavailableNotice,
  type TurnCommandContext,
} from './turncommands.js';
import type { Skill } from '../skills/skills.js';
import type { Mode } from '../types.js';

const ctx = (mode: Mode, over: Partial<TurnCommandContext> = {}): TurnCommandContext => ({
  mode,
  searchAvailable: () => true,
  offline: () => false,
  ...over,
});

describe('parseCommand', () => {
  it('lowercases the name and keeps the args as typed', () => {
    expect(parseCommand('/Search  React 19 ')).toEqual({ name: 'search', args: ' React 19 ' });
  });

  it('has no args for a bare command', () => {
    expect(parseCommand('/compact')).toEqual({ name: 'compact', args: '' });
  });
});

describe('resolveTurnCommand', () => {
  it('is null for a command that starts no turn', () => {
    expect(resolveTurnCommand('help', '', ctx('agent'))).toBeNull();
    expect(resolveTurnCommand('issue', '14', ctx('agent'))).toBeNull();
  });

  describe('/implement', () => {
    it('refuses where nothing can edit', () => {
      for (const mode of ['shell', 'chat'] as const) {
        const cmd = resolveTurnCommand('implement', '', ctx(mode));
        expect(cmd).toMatchObject({ kind: 'refuse' });
        expect(cmd?.kind === 'refuse' && cmd.content).toContain(`${mode} mode`);
      }
    });

    it('leaves plan mode for the picked mode and says so before the turn', () => {
      expect(resolveTurnCommand('implement', '', ctx('plan', { implementMode: 'grind' }))).toEqual({
        kind: 'submit',
        modelText: buildImplementPrompt(''),
        mode: 'grind',
        switchTo: 'grind',
        before: [{ content: 'Grind mode — implementing the plan above.' }],
        after: [],
        echo: false,
      });
    });

    it('defaults to agent from plan mode when the picker was not asked', () => {
      expect(resolveTurnCommand('implement', '', ctx('plan'))).toMatchObject({
        mode: 'agent',
        switchTo: 'agent',
      });
    });

    it('keeps minimal and grind as themselves and switches nothing', () => {
      for (const mode of ['minimal', 'grind'] as const) {
        const cmd = resolveTurnCommand('implement', '', ctx(mode));
        expect(cmd).toMatchObject({ kind: 'submit', mode, before: [] });
        expect(cmd).not.toHaveProperty('switchTo');
      }
    });

    it('runs one agent turn out of agent or vibe without leaving the mode', () => {
      for (const mode of ['agent', 'vibe'] as const) {
        const cmd = resolveTurnCommand('implement', 'tests first', ctx(mode));
        expect(cmd).toMatchObject({
          mode: 'agent',
          modelText: buildImplementPrompt('tests first'),
        });
        expect(cmd).not.toHaveProperty('switchTo');
      }
    });
  });

  describe('/compact', () => {
    it('refuses on the chat side and in shell mode', () => {
      expect(resolveTurnCommand('compact', '', ctx('chat'))).toEqual({
        kind: 'refuse',
        content: "/compact isn't available in chat mode.",
      });
      expect(resolveTurnCommand('compact', '', ctx('shell'))).toMatchObject({ kind: 'refuse' });
    });

    it('echoes by hand and announces itself, since the turn has no user message', () => {
      expect(resolveTurnCommand('compact', '', ctx('agent'))).toEqual({
        kind: 'submit',
        modelText: 'compact',
        before: [{ content: 'Compacting context…', tone: 'info', emphasis: 'line' }],
        after: [],
        echo: true,
        manualCompact: true,
      });
    });

    it('runs as an agent turn out of vibe, whose plan phase would claim it', () => {
      expect(resolveTurnCommand('compact', '', ctx('vibe'))).toMatchObject({ mode: 'agent' });
    });
  });

  describe('/search', () => {
    it('asks for a query', () => {
      const cmd = resolveTurnCommand('search', '  ', ctx('agent'));
      expect(cmd?.kind === 'refuse' && cmd.content).toMatch(/^Usage: \/search <query>/);
    });

    it('refuses by mode before it looks for a provider', () => {
      const searchAvailable = (): boolean => {
        throw new Error('not reached');
      };
      expect(resolveTurnCommand('search', 'q', ctx('minimal', { searchAvailable }))).toEqual({
        kind: 'refuse',
        content: searchModeRefusal('minimal'),
      });
    });

    it('names the cause when the session has no search tool', () => {
      const none = { searchAvailable: () => false };
      expect(resolveTurnCommand('search', 'q', ctx('agent', none))).toEqual({
        kind: 'refuse',
        content: searchUnavailableNotice(false),
      });
      expect(
        resolveTurnCommand('search', 'q', ctx('agent', { ...none, offline: () => true })),
      ).toEqual({ kind: 'refuse', content: searchUnavailableNotice(true) });
    });

    it('submits in the current mode with no override', () => {
      expect(resolveTurnCommand('search', ' react 19 ', ctx('plan'))).toEqual({
        kind: 'submit',
        modelText: buildSearchPrompt('react 19'),
        before: [],
        after: [],
        echo: false,
      });
    });

    it('checks and runs as agent out of vibe', () => {
      const asked: Mode[] = [];
      const cmd = resolveTurnCommand(
        'search',
        'q',
        ctx('vibe', {
          searchAvailable: mode => {
            asked.push(mode);
            return true;
          },
        }),
      );
      expect(asked).toEqual(['agent']);
      expect(cmd).toMatchObject({ kind: 'submit', mode: 'agent' });
    });
  });
});

describe('resolveSkillCommand', () => {
  const skill = { name: 'issue', body: 'Work the issue.', description: 'd' } as Skill;

  it('is null when no skill has the name', () => {
    expect(resolveSkillCommand('nope', '', { skills: [skill], mode: 'agent' })).toBeNull();
  });

  it('sends the body and says so after the bubble', () => {
    expect(resolveSkillCommand('issue', '', { skills: [skill], mode: 'agent' })).toEqual({
      kind: 'submit',
      modelText: 'Work the issue.',
      before: [],
      after: [
        { content: 'Skill /issue applied — its body was sent as this prompt.', tone: 'info' },
      ],
      echo: false,
      skill: 'issue',
    });
  });

  it('appends the text after the name, with pasted text expanded', () => {
    const cmd = resolveSkillCommand('issue', ' 14 [Pasted text #1 +2 lines] ', {
      skills: [skill],
      mode: 'agent',
      pastes: [{ marker: '[Pasted text #1 +2 lines]', text: 'a\nb' }],
    });
    expect(cmd?.modelText).toBe('Work the issue.\n\n14 a\nb');
    expect(cmd?.after[0].content).toBe(
      'Skill /issue applied — its body was sent as this prompt, with your text after it.',
    );
  });

  it('plans then implements in vibe mode, like any other prompt', () => {
    expect(resolveSkillCommand('issue', '', { skills: [skill], mode: 'vibe' })).toMatchObject({
      mode: 'vibe',
    });
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

// /search (#829). The command is the user taking the decision away from the model, so what it sends
// has to be binding enough that a small model uses `search` rather than answering from memory — but
// only where the session actually has the tool, which is what the two refusals are for.
describe('/search prompt and refusals', () => {
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
