import ignore from 'ignore';
import { describe, expect, it } from 'vitest';
import type { ContextBundle, Tool } from '../types.js';
import { buildSystemPrompt } from './prompt.js';

// Grind mode (#556): the agent turn with a step-by-step verification procedure in place of the agent
// rules, and bash/read/edit as the tools. What matters is that every step is an observable action
// (so adherence can be graded from a transcript) and that the prompt points at no tool it lacks.

function makeBundle(): ContextBundle {
  return {
    projectSummary: 'Top-level entries: src/, package.json, AGENTS.md',
    repoMap: 'src/agent/loop.ts\nsrc/ui/App.tsx',
    instructions: 'Always run the linter before committing.',
    cwd: '/repo',
    hash: 'test',
    fileIndex: [],
    ignore: ignore(),
    skills: [],
  };
}

const tool = (name: string): Tool => ({
  name,
  description: '',
  parameters: { type: 'object', properties: {} },
  run: async () => ({ summary: '' }),
});

describe('grind system prompt', () => {
  it('lays out the seven steps in order', () => {
    const p = buildSystemPrompt({ bundle: makeBundle(), grind: true });
    const heads = [
      '1. Pin down the task.',
      '2. Look before you act.',
      '3. Choose deliberately.',
      '4. Make the smallest change',
      '5. Prove it by running something.',
      '6. Review your own diff.',
      '7. Report honestly.',
    ];
    let at = -1;
    for (const h of heads) {
      const i = p.indexOf(h);
      expect(i, h).toBeGreaterThan(at);
      at = i;
    }
  });

  it('asks for verification by running, not by re-thinking', () => {
    const p = buildSystemPrompt({ bundle: makeBundle(), grind: true });
    // The line that keeps grinding out of the reasoning channel, where the loop detectors read it
    // as rumination.
    expect(p).toContain('Verify by running, not by re-thinking.');
    expect(p).toContain('A check you only reasoned through does not count.');
    // Throwaway checks go to temp, which the sandbox leaves writable, not into the project.
    expect(p).toContain('mktemp -d');
  });

  it('keeps the project context, unlike minimal', () => {
    const p = buildSystemPrompt({ bundle: makeBundle(), grind: true });
    expect(p).toContain('Working directory: /repo');
    expect(p).toContain('Top-level entries');
    expect(p).toContain('src/agent/loop.ts');
    expect(p).toContain('Always run the linter');
  });

  it('names no tool the mode does not have', () => {
    const p = buildSystemPrompt({ bundle: makeBundle(), grind: true, sandbox: true });
    // `grep` appears on purpose, as a command through bash; the dedicated tools must not.
    for (const absent of [
      'glob',
      'subagent',
      'fetch_url',
      'search for a query',
      'Use their exact names',
    ]) {
      expect(p).not.toContain(absent);
    }
    expect(p).toContain('grep through bash');
    // The read/edit gutter contract applies: both tools are in the list.
    expect(p).toContain('NNNNN│');
  });

  it('names the web tools only when the turn has them (#589)', () => {
    const both = buildSystemPrompt({
      bundle: makeBundle(),
      grind: true,
      sandbox: true,
      canFetch: true,
      canSearch: true,
    });
    expect(both).toContain('use search/fetch_url rather than guessing or curl');
    expect(both).toContain('use fetch_url for a web page');
    const fetchOnly = buildSystemPrompt({ bundle: makeBundle(), grind: true, canFetch: true });
    expect(fetchOnly).toContain('use fetch_url rather than guessing');
    expect(fetchOnly).not.toContain('search/');
  });

  it('gates the ask_user rule on the tool', () => {
    const withAsk = buildSystemPrompt({ bundle: makeBundle(), grind: true, canAsk: true });
    const without = buildSystemPrompt({ bundle: makeBundle(), grind: true, canAsk: false });
    expect(withAsk).toContain('ask_user');
    expect(without).not.toContain('ask_user');
  });

  it('is reachable only through the flag, and loses to chat/plan', () => {
    const agent = buildSystemPrompt({ bundle: makeBundle() });
    expect(agent).not.toContain('GRIND MODE');
    const plan = buildSystemPrompt({ bundle: makeBundle(), mode: 'plan', grind: true });
    expect(plan).toContain('PLAN MODE');
    expect(plan).not.toContain('GRIND MODE');
  });
});

describe('grind tool list', () => {
  it('offers bash, read and edit, plus the web tools (#589), and nothing else that works', async () => {
    const { grindTools } = await import('../tools/index.js');
    const names = grindTools(undefined, { offline: true }).map(t => t.name);
    expect(names.filter(n => n !== 'ask_user')).toEqual(['read', 'edit', 'bash']);
    const online = grindTools().map(t => t.name);
    expect(online.filter(n => n !== 'ask_user')).toEqual(['read', 'edit', 'bash', 'fetch_url']);
  });

  it('describes bash without steering at tools grind lacks', async () => {
    const { grindBashTool, bashTool } = await import('../tools/bash.js');
    for (const absent of ['grep, edit, write, list', 'Prefer the dedicated tools']) {
      expect(grindBashTool.description).not.toContain(absent);
    }
    expect(grindBashTool.name).toBe('bash');
    expect(grindBashTool.run).toBe(bashTool.run);
  });
});

describe('grind mode routing', () => {
  it('runs as an agent turn with its own tool list and prompt flag', async () => {
    const { turnPromptMode, turnTools, isGrindPrompt, isMinimalPrompt } =
      await import('../ui/commands.js');
    expect(turnPromptMode('grind')).toBe('agent');
    expect(isGrindPrompt('grind')).toBe(true);
    expect(isGrindPrompt('agent')).toBe(false);
    expect(isMinimalPrompt('grind')).toBe(false);
    const lists = { agent: 'A', plan: 'P', chat: 'C', minimal: 'M', grind: 'G' };
    expect(turnTools('grind', lists)).toBe('G');
  });

  it('is a launch mode, persisted like the other work modes', async () => {
    const { resolveDefaultMode } = await import('../config.js');
    const { persistableMode } = await import('../laststate.js');
    const prior = process.env.REIKA_DEFAULT_MODE;
    process.env.REIKA_DEFAULT_MODE = 'grind';
    try {
      expect(resolveDefaultMode()).toBe('grind');
      expect(persistableMode('grind')).toBe('grind');
    } finally {
      if (prior === undefined) delete process.env.REIKA_DEFAULT_MODE;
      else process.env.REIKA_DEFAULT_MODE = prior;
    }
  });

  it('keys the warm cache apart from agent and minimal', async () => {
    const { warmKey } = await import('./warm.js');
    const base = {
      history: [],
      bundle: makeBundle(),
      config: { model: 'm', baseURL: 'u' } as never,
      tools: [tool('bash')],
      promptMode: 'agent' as const,
      calibration: 1,
    };
    const grind = warmKey({ ...base, grindPrompt: true });
    expect(grind).not.toBe(warmKey(base));
    expect(grind).not.toBe(warmKey({ ...base, minimalPrompt: true }));
  });
});
