import { describe, expect, it } from 'vitest';
import {
  helpText,
  resolveReplyCommand,
  unknownCommandText,
  type ReplyCommandContext,
} from './replycommands.js';
import { COMMANDS } from '../ui/commands.js';
import type { Skill } from '../skills/skills.js';

const ctx = (over: Partial<ReplyCommandContext> = {}): ReplyCommandContext => ({
  cwd: '/repo',
  skills: [],
  messages: [],
  usage: { promptTokens: 1200, completionTokens: 340 },
  startedAt: 0,
  approvals: { approved: 0, declined: 0 },
  mcpList: () => 'mcp servers: none',
  ...over,
});

const skill = (over: Partial<Skill>): Skill => ({
  name: 'issue',
  description: 'work an issue',
  body: 'body',
  source: 'global',
  path: '/skills/issue.md',
  triggers: [],
  ...over,
});

describe('resolveReplyCommand', () => {
  it('is null for a command that does more than print', () => {
    for (const name of ['new', 'model', 'implement', 'plan', 'nope']) {
      expect(resolveReplyCommand(name, ctx())).toBeNull();
    }
  });

  it('/help lists every command in the menu', () => {
    const help = resolveReplyCommand('help', ctx()) ?? '';
    expect(help).toBe(helpText());
    expect(help.startsWith('Commands:')).toBe(true);
    const missing = COMMANDS.filter(c => !new RegExp(`/${c.name}\\b`).test(help)).map(c => c.name);
    expect(missing).toEqual([]);
  });

  it('/cwd prints the working directory, or says it is unknown', () => {
    expect(resolveReplyCommand('cwd', ctx())).toBe('/repo');
    expect(resolveReplyCommand('cwd', ctx({ cwd: undefined }))).toBe('(unknown)');
  });

  it('/tokens prints both counts and marks an estimate', () => {
    expect(resolveReplyCommand('tokens', ctx())).toBe('prompt:     1200\ncompletion: 340');
    expect(
      resolveReplyCommand(
        'tokens',
        ctx({ usage: { promptTokens: 9, completionTokens: 2, estimated: true } }),
      ),
    ).toBe('prompt:     ~9\ncompletion: ~2');
  });

  it('/stats says so when nothing has happened yet', () => {
    expect(resolveReplyCommand('stats', ctx())).toBe('No activity yet.');
  });

  it('/stats summarizes a session that has run a turn', () => {
    const stats = resolveReplyCommand(
      'stats',
      ctx({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        startedAt: Date.now(),
      }),
    );
    expect(stats).toContain('Session summary');
    expect(stats).toContain('1 user');
  });

  it('/skills says where to put one when none are loaded', () => {
    expect(resolveReplyCommand('skills', ctx())).toMatch(/^No skills loaded\. Drop \*\.md files/);
  });

  it('/skills labels each skill with where it came from', () => {
    const listing = resolveReplyCommand(
      'skills',
      ctx({
        skills: [
          skill({}),
          skill({ name: 'deploy', description: 'ship it', source: 'project' }),
          skill({ name: 'verify', description: 'drive it', from: '.agents/skills' }),
        ],
      }),
    );
    expect(listing?.split('\n')).toEqual([
      'Available skills (invoke as /<name>):',
      '  /issue            work an issue ',
      '  /deploy           ship it (project)',
      '  /verify           drive it (.agents/skills)',
    ]);
  });

  it('/mcp prints the session listing, or says the session has none', () => {
    expect(resolveReplyCommand('mcp', ctx())).toBe('mcp servers: none');
    expect(resolveReplyCommand('mcp', ctx({ mcpList: () => undefined }))).toBe(
      'MCP is not available in this session.',
    );
  });
});

describe('unknownCommandText', () => {
  it('names the command and points at /help', () => {
    expect(unknownCommandText('nope')).toBe('Unknown command: /nope. Try /help.');
  });
});
