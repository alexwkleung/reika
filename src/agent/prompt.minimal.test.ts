import ignore from 'ignore';
import { describe, expect, it } from 'vitest';
import type { ContextBundle, Tool } from '../types.js';
import { buildSystemPrompt } from './prompt.js';

// Minimal mode (#391): the shell, and no project information at all. The omission IS the mode, so
// most of what is asserted here is absence — and absence is exactly what a test has to pin, since
// nothing about a prompt that carries too much fails loudly.

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

describe('minimal system prompt', () => {
  it('carries the cwd and nothing else from the bundle', () => {
    const p = buildSystemPrompt({ bundle: makeBundle(), minimal: true });
    expect(p).toContain('Working directory: /repo');
    // The three upfront-context blocks, by their headers and by their content.
    expect(p).not.toContain('Project:');
    expect(p).not.toContain('Repo map:');
    expect(p).not.toContain('Project instructions:');
    expect(p).not.toContain('Top-level entries');
    expect(p).not.toContain('src/agent/loop.ts');
    expect(p).not.toContain('Always run the linter');
  });

  it('names no tool the mode does not have', () => {
    const p = buildSystemPrompt({ bundle: makeBundle(), minimal: true });
    // The agent prompt's rules are built around these; a filtered version of that list would have
    // left them behind as dangling pointers.
    for (const absent of ['NNNNN│', 'old_string', 'edit/write', 'Use their exact names']) {
      expect(p).not.toContain(absent);
    }
    // Tool names that are ONLY ever tool names here, word-bounded. `read`, `list` and `write` are
    // deliberately not in this loop: they are ordinary English verbs the minimal rules use on
    // purpose ("read its output", "list the directory", "Write it back"), so a bare name check
    // cannot tell the verb from the tool. The constructs above are what actually distinguish a
    // reference to the TOOL, and those are asserted exactly.
    for (const absent of ['grep', 'glob', 'edit', 'subagent']) {
      expect(p).not.toMatch(new RegExp(`\\b${absent}\\b`));
    }
    expect(p).toContain('You have one tool: a shell.');
  });

  it('keeps the rules that are mode-independent, re-expressed for the shell', () => {
    const p = buildSystemPrompt({ bundle: makeBundle(), minimal: true });
    // Ground every claim — matters more here, not less: with no repo map the model has nothing but
    // its priors to confabulate from.
    expect(p).toContain('MUST run a command and read its output before answering');
    expect(p).toContain('Never describe code from general knowledge');
    // Orientation, which every other mode gets for free from the bundle.
    expect(p).toContain('You are starting blind');
    expect(p).toContain('Never guess a path');
    // Read-before-write, the contract the read-first gate cannot enforce without the edit tool.
    expect(p).toContain('Before you change a file, read it');
    expect(p).toContain('Never rewrite a file you have not just read');
  });

  it('gates the ask_user rule on the tool, exactly as the agent prompt does', () => {
    const withAsk = buildSystemPrompt({ bundle: makeBundle(), minimal: true, canAsk: true });
    const without = buildSystemPrompt({ bundle: makeBundle(), minimal: true, canAsk: false });
    expect(withAsk).toContain('ask_user');
    expect(without).not.toContain('ask_user');
    // Numbering closes over the gap rather than leaving a hole.
    expect(withAsk).toContain('5. Stopping to ask');
    expect(without).toContain('4. If a command fails');
    expect(without).not.toContain('5.');
  });

  it('is not reachable except through the flag', () => {
    // Plain agent mode must be untouched by any of this: the flag is the only door in.
    const agent = buildSystemPrompt({ bundle: makeBundle() });
    expect(agent).toContain('Repo map:');
    expect(agent).not.toContain('You have one tool: a shell.');
    // And the flag loses to chat/plan, which have their own prompts and their own tool lists.
    const chat = buildSystemPrompt({ bundle: makeBundle(), mode: 'chat', minimal: true });
    expect(chat).not.toContain('You have one tool: a shell.');
    const plan = buildSystemPrompt({ bundle: makeBundle(), mode: 'plan', minimal: true });
    expect(plan).toContain('PLAN MODE');
  });
});

describe('minimal tool list', () => {
  it('offers the shell and nothing that reads or writes on its own', async () => {
    const { minimalTools } = await import('../tools/index.js');
    const names = minimalTools().map(t => t.name);
    expect(names).toContain('bash');
    for (const absent of ['read', 'grep', 'glob', 'list', 'edit', 'write', 'subagent']) {
      expect(names).not.toContain(absent);
    }
    // No web tools even with a provider configured — see the note in tools/index.ts.
    expect(names).not.toContain('search');
    expect(names).not.toContain('fetch_url');
  });

  it("does not point the model at tools it doesn't have in the bash description", async () => {
    const { minimalBashTool, bashTool } = await import('../tools/bash.js');
    // The default description opens by steering toward read/grep/edit/write/list, and that sentence
    // rides the prefix on every round — a worse phantom pointer than the withdrawal directive's,
    // which only appears once a loop is active.
    expect(bashTool.description).toContain('read, grep, edit, write, list');
    for (const absent of ['read, grep', 'Prefer the dedicated tools']) {
      expect(minimalBashTool.description).not.toContain(absent);
    }
    expect(minimalBashTool.description).toContain('This is your only tool');
    // Same tool underneath: only the description differs.
    expect(minimalBashTool.name).toBe('bash');
    expect(minimalBashTool.run).toBe(bashTool.run);
  });

  it('drops ask_user with REIKA_ASK=0, taking its prompt rule with it', async () => {
    const prior = process.env.REIKA_ASK;
    process.env.REIKA_ASK = '0';
    try {
      const { minimalTools } = await import('../tools/index.js');
      const names = minimalTools().map(t => t.name);
      expect(names).toEqual(['bash']);
      const canAsk = names.includes('ask_user');
      expect(buildSystemPrompt({ bundle: makeBundle(), minimal: true, canAsk })).not.toContain(
        'ask_user',
      );
    } finally {
      if (prior === undefined) delete process.env.REIKA_ASK;
      else process.env.REIKA_ASK = prior;
    }
  });
});

describe('minimal mode routing', () => {
  it('runs as an agent turn everywhere below the prompt', async () => {
    const { turnPromptMode, turnTools, isMinimalPrompt } = await import('../ui/commands.js');
    // The load-bearing decision: NOT a fourth PromptMode. Every `promptMode === 'agent'` branch in
    // the loop — plan-handoff distill, plan progress, the two done-gates — must still apply.
    expect(turnPromptMode('minimal')).toBe('agent');
    expect(isMinimalPrompt('minimal')).toBe(true);
    expect(isMinimalPrompt('agent')).toBe(false);
    // But it gets its own tool list.
    const lists = { agent: 'A', plan: 'P', chat: 'C', minimal: 'M', grind: 'G' };
    expect(turnTools('minimal', lists)).toBe('M');
    expect(turnTools('agent', lists)).toBe('A');
    expect(turnTools('vibe', lists)).toBe('P');
    expect(turnTools('chat', lists)).toBe('C');
  });

  it('is a launch mode', async () => {
    const { resolveDefaultMode } = await import('../config.js');
    const prior = process.env.REIKA_DEFAULT_MODE;
    process.env.REIKA_DEFAULT_MODE = 'minimal';
    try {
      // The mode's saving is the upfront load, which a session that started in agent mode has
      // already paid — so launching into it is the path that actually buys anything.
      expect(resolveDefaultMode()).toBe('minimal');
    } finally {
      if (prior === undefined) delete process.env.REIKA_DEFAULT_MODE;
      else process.env.REIKA_DEFAULT_MODE = prior;
    }
  });

  it('keys the warm cache apart from agent despite sharing a promptMode', async () => {
    const { warmKey } = await import('./warm.js');
    const base = {
      history: [],
      bundle: makeBundle(),
      config: { model: 'm', baseURL: 'u' } as never,
      tools: [tool('bash')],
      promptMode: 'agent' as const,
      calibration: 1,
    };
    // Both send promptMode 'agent' with very different system prompts. A shared key would serve a
    // warm built from the other one's prefix — a guaranteed miss, and a silent one.
    expect(warmKey({ ...base, minimalPrompt: true })).not.toBe(warmKey(base));
  });
});
