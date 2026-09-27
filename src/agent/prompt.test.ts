import { afterEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { buildSystemPrompt, reikaSelfLine } from './prompt.js';
import { promptGates } from './loop.js';
import { defaultTools, planTools } from '../tools/index.js';
import type { ContextBundle } from '../types.js';

const bundle: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/repo',
  hash: 'h',
  fileIndex: [],
  ignore: ignore(),
  skills: [],
};

const planPrompt = (): string => buildSystemPrompt({ bundle, mode: 'plan' });
// Line wrapping is a formatting choice; the claims are what matter.
const planPromptFlat = (): string => planPrompt().replace(/\s+/g, ' ');

// The plan prompt states what plan mode CAN do. That claim is only true while it matches the tool
// list, and a model told a tool "will fail" will not reach for one that is actually there — so the
// two are asserted together rather than trusted to stay in step.
describe('plan prompt tracks planTools (#109)', () => {
  afterEach(() => {
    delete process.env.REIKA_PLAN_BASH;
  });

  it('offers read-only bash by default, while bash IS in the tool list', () => {
    delete process.env.REIKA_PLAN_BASH;
    expect(planTools().map(t => t.name)).toContain('bash');
    const prompt = planPromptFlat();
    expect(prompt).toContain('READ-ONLY shell commands through bash');
    expect(prompt).not.toContain('or run commands');
  });

  it('says commands are unavailable under =0, when bash is not in the tool list', () => {
    process.env.REIKA_PLAN_BASH = '0';
    expect(planTools().map(t => t.name)).not.toContain('bash');
    expect(planPromptFlat()).toContain('CANNOT edit, write, or run commands');
  });

  it('never offers writing, under either setting', () => {
    for (const flag of [undefined, '0']) {
      if (flag) process.env.REIKA_PLAN_BASH = flag;
      else delete process.env.REIKA_PLAN_BASH;
      expect(planPromptFlat()).toMatch(/CANNOT edit/);
    }
  });
});

// Plan mode's web pair (#290) is the one exception to "You can ONLY explore the codebase", and it
// gets the same treatment as bash above: named only when the tool is in the list. `planTools()` with
// no config has `fetch_url` (unconditional, as in agent mode) and no `search` (no provider), so the
// two are asserted separately.
describe('plan prompt tracks the web tools (#290)', () => {
  const planPromptWeb = (o: { canFetch?: boolean; canSearch?: boolean }): string =>
    buildSystemPrompt({ bundle, mode: 'plan', ...o }).replace(/\s+/g, ' ');

  it('names the tools planTools actually registers, and only those', () => {
    const names = planTools().map(t => t.name);
    expect(names).toContain('fetch_url');
    expect(names).not.toContain('search');
    expect(planPromptWeb({ canFetch: true, canSearch: false })).toContain('may also use fetch_url');
    expect(planPromptWeb({ canFetch: true, canSearch: false })).not.toContain('search');
    expect(planPromptWeb({ canFetch: true, canSearch: true })).toContain(
      'may also use search/fetch_url',
    );
  });

  // Offline is the other arm that has neither tool; pointing at one there is the #377 phantom
  // pointer, and with neither the prompt stays byte-identical to the pre-#290 text.
  it('says nothing about the web when neither tool is present', () => {
    const none = planPromptWeb({});
    expect(none).not.toContain('may also use');
    expect(buildSystemPrompt({ bundle, mode: 'plan', canFetch: false, canSearch: false })).toBe(
      planPrompt(),
    );
  });

  // The exception is scoped to what the codebase cannot answer, and the repo stays the tiebreaker:
  // an unrestricted "you may search the web" is a new way to keep exploring instead of writing the
  // plan, which every other line here pulls against.
  it('scopes the lookup to what the codebase cannot answer', () => {
    const plan = planPromptWeb({ canFetch: true, canSearch: true });
    expect(plan).toContain('For what the codebase cannot answer');
    expect(plan).toContain('it does not replace reading the code the plan changes');
  });
});

// Same coupling as the plan-prompt block above, for the same reason: rule 7 names `ask_user`, and a
// prompt that points a model at a tool it has not been given is worse than saying nothing.
describe('agent prompt tracks the ask_user tool (#214)', () => {
  afterEach(() => {
    delete process.env.REIKA_ASK;
  });

  const agentPrompt = (canAsk?: boolean): string =>
    buildSystemPrompt({ bundle, mode: 'agent', canAsk }).replace(/\s+/g, ' ');

  it('offers ask_user by default, with no flag set', () => {
    delete process.env.REIKA_ASK;
    expect(defaultTools().map(t => t.name)).toContain('ask_user');
    expect(agentPrompt(true)).toContain('ask_user');
  });

  // The baseline arm of any #198 measurement: REIKA_ASK=0 removes the tool AND rule 7 with it, so
  // the comparison runs against a byte-identical prompt rather than a different build.
  it('registers nothing and says nothing when REIKA_ASK=0', () => {
    process.env.REIKA_ASK = '0';
    expect(defaultTools().map(t => t.name)).not.toContain('ask_user');
    expect(planTools().map(t => t.name)).not.toContain('ask_user');
    expect(agentPrompt(false)).not.toContain('ask_user');
  });

  // Subagents run with ask_user filtered out (makeSpawnSubagent) — there is nobody to answer a
  // question raised underneath a tool call the parent is already blocked on.
  it('says nothing about asking when the tool is absent', () => {
    expect(agentPrompt(false)).not.toContain('ask_user');
    expect(agentPrompt(undefined)).not.toContain('ask_user');
  });

  // Phrased as permission, not instruction: it exists to counterweight rule 4 ("do not give up"),
  // which otherwise makes stopping to ask read as quitting.
  it('frames asking as a legitimate outcome rather than an instruction to ask', () => {
    expect(agentPrompt(true)).toContain('Stopping to ask is a legitimate outcome');
  });
});

// The subagent nudge (#273) is a routing rule keyed on the request's shape — NOT rule 7's
// permission shape, which was the first arm and got 0/2 uptake (see the comment in prompt.ts).
// Flagged so the baseline arm runs against a byte-identical prompt, and keyed off the tool list so
// a subagent (no recursion) and plan mode (no subagent tool) are never pointed at a tool they do
// not have.
describe('agent prompt subagent nudge (#273)', () => {
  afterEach(() => {
    delete process.env.REIKA_SUBAGENT_NUDGE;
  });

  const agentPrompt = (o: { canAsk?: boolean; canSubagent?: boolean }): string =>
    buildSystemPrompt({ bundle, mode: 'agent', ...o }).replace(/\s+/g, ' ');

  it('is byte-identical to the unflagged prompt when the flag is unset', () => {
    delete process.env.REIKA_SUBAGENT_NUDGE;
    const off = buildSystemPrompt({ bundle, mode: 'agent', canAsk: true });
    expect(buildSystemPrompt({ bundle, mode: 'agent', canAsk: true, canSubagent: true })).toBe(off);
    expect(off).not.toContain('subagent');
  });

  it('adds the line under the flag only when the tool is present', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    expect(agentPrompt({ canAsk: true, canSubagent: true })).toContain(
      'FIRST tool call is subagent',
    );
    expect(agentPrompt({ canAsk: true, canSubagent: false })).not.toContain('subagent');
    expect(agentPrompt({ canAsk: true })).not.toContain('subagent');
  });

  // The permission-shaped first arm at the tail of the list got 0/2 uptake: the trigger was a
  // forecast and the position was where the model's attention isn't. It sits next to rule 2 (the
  // grep the model reaches for at round 0) and the rules after it renumber — no gap, no duplicate.
  it('is rule 3, right after the grep rule, and renumbers the rest', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    const p = agentPrompt({ canAsk: true, canSubagent: true });
    expect(p).toContain('2. To find where something is defined');
    expect(p).toContain('3. When the request is to trace');
    expect(p).toContain('4. Before edit');
    expect(p).toContain('8. Stopping to ask');
    expect(p).not.toContain('9.');
    expect(agentPrompt({ canAsk: false, canSubagent: true })).not.toContain('8.');
  });

  // Scoped to exploration: the value is N reads collapsing into one digest payload in the parent;
  // a delegated edit is one the parent never read the file for. The closing sentence guards the
  // negative control — a one-file question must not be delegated.
  it('frames it around reading and reporting, not delegating edits', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    const p = agentPrompt({ canAsk: true, canSubagent: true });
    expect(p).toContain('ask for the chain with file and function names, not line numbers');
    expect(p).toContain('one or two files answer, read yourself');
    expect(p).not.toMatch(/subagent[^.]*\bedit/);
  });

  it('never appears in the plan prompt', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    expect(planTools().map(t => t.name)).not.toContain('subagent');
    expect(buildSystemPrompt({ bundle, mode: 'plan', canAsk: true })).not.toContain('subagent');
  });
});

// The plan prompt carries its own ask rule (#272): the plan is a one-shot handoff to an
// implementation turn with no refinement round between (#46 is open), so a wrong reading of the
// request costs the whole implementation turn. Same tool-list coupling as the agent prompt, but
// deliberately NOT the same line — see the comment on rule 5 in prompt.ts.
describe('plan prompt tracks the ask_user tool (#272)', () => {
  afterEach(() => {
    delete process.env.REIKA_ASK;
  });

  const planPromptWith = (canAsk?: boolean): string =>
    buildSystemPrompt({ bundle, mode: 'plan', canAsk }).replace(/\s+/g, ' ');

  it('names ask_user by default, with no flag set', () => {
    delete process.env.REIKA_ASK;
    expect(planTools().map(t => t.name)).toContain('ask_user');
    expect(planPromptWith(true)).toContain('use ask_user ONCE');
  });

  it('says nothing about asking when the tool is absent', () => {
    expect(planPromptWith(false)).not.toContain('ask_user');
    expect(planPromptWith(undefined)).not.toContain('ask_user');
  });

  // Every other plan rule pulls toward converging on a written plan; a bare permission-to-pause
  // (the agent prompt's framing) would pull against that and hand a stalling model a new way not to
  // write. So the plan rule is pinned to the plan on both sides and must stay that way.
  it('routes the ask into the plan rather than granting permission to pause', () => {
    const plan = planPromptWith(true);
    expect(plan).toContain('before writing the plan, then write the plan for the answer');
    expect(plan).toContain('never ask instead of writing the plan');
    expect(plan).not.toContain('Stopping to ask');
  });

  // The ask is for what the code cannot settle — approach, scope, placement — not for what a tool
  // could answer; a low-quant model asks about everything if the trigger is "when unclear".
  it('scopes the ask to what the code cannot settle', () => {
    const plan = planPromptWith(true);
    expect(plan).toContain('the code you have read does not settle it');
    expect(plan).toContain('Never ask what grep/read could tell you');
  });

  // REIKA_ASK=0 is the baseline arm for measuring the rule: tool and rule leave together, so the
  // comparison runs against a prompt that differs by exactly this block.
  it('drops the rule with the tool under REIKA_ASK=0', () => {
    process.env.REIKA_ASK = '0';
    expect(planTools().map(t => t.name)).not.toContain('ask_user');
    expect(planPromptWith(false)).not.toContain('ask_user');
  });
});

// The sandbox sentence (#163) is a claim about this turn's bash, so it tracks the gate rather than
// the flag: on Linux or under REIKA_SANDBOX=0 it would tell the model a genuine DNS failure "may be
// the sandbox" — the misattribution the footer is gated on output to avoid — and in minimal mode or
// offline it would route to a fetch_url/search the model does not have (#377).
describe('agent prompt sandbox sentence (#163)', () => {
  const agent = (o: { sandbox?: boolean; canFetch?: boolean; canSearch?: boolean }): string =>
    buildSystemPrompt({ bundle, mode: 'agent', ...o });

  it('is absent when nothing is sandboxed', () => {
    expect(agent({ sandbox: false })).not.toContain('sandbox');
    expect(agent({})).not.toContain('sandbox');
  });

  it('routes to the web tools the turn actually offers', () => {
    const both = agent({ sandbox: true, canFetch: true, canSearch: true });
    expect(both).toContain('local sandbox');
    expect(both).toContain('fetch_url');
    expect(both).toContain('search for a query');

    const fetchOnly = agent({ sandbox: true, canFetch: true, canSearch: false });
    expect(fetchOnly).toContain('fetch_url');
    expect(fetchOnly).not.toContain('search for a query');

    const neither = agent({ sandbox: true, canFetch: false, canSearch: false });
    expect(neither).toContain('local sandbox');
    expect(neither).not.toContain('fetch_url');
    expect(neither).not.toContain('search for a query');
    expect(neither).toContain('tell the user');
  });
});

// Unattended (#526): ask_user is gone, and its slot says to decide and name the choice — the one
// part of an unattended run only the model can report.
describe('decide-alone rule (#526)', () => {
  const flat = (o: Parameters<typeof buildSystemPrompt>[0]): string =>
    buildSystemPrompt(o).replace(/\s+/g, ' ');

  it('takes the ask rule slot in agent, minimal and plan prompts', () => {
    const agent = flat({ bundle, mode: 'agent', decideAlone: true });
    expect(agent).toContain('No one can answer questions this session');
    expect(agent).toContain('name each such choice in your final reply');
    expect(agent).not.toContain('ask_user');
    expect(flat({ bundle, mode: 'agent', minimal: true, decideAlone: true })).toContain(
      'No one can answer questions this session',
    );
    const plan = flat({ bundle, mode: 'plan', decideAlone: true });
    expect(plan).toContain('state that choice at the top of the plan');
    expect(plan).not.toContain('ask_user');
  });

  it('leaves the prompt byte-identical when off', () => {
    for (const mode of ['agent', 'plan'] as const) {
      expect(buildSystemPrompt({ bundle, mode, decideAlone: false })).toBe(
        buildSystemPrompt({ bundle, mode }),
      );
    }
  });
});

// One gate for runTurn and the warm prefix; on only when unattended AND ask_user is absent.
describe('promptGates decideAlone (#526)', () => {
  const withAsk = defaultTools();
  const noAsk = withAsk.filter(t => t.name !== 'ask_user');

  it('is on only unattended with no ask_user', () => {
    expect(promptGates(noAsk, false, true).decideAlone).toBe(true);
    expect(promptGates(withAsk, false, true).decideAlone).toBe(false);
    expect(promptGates(noAsk, false, false).decideAlone).toBe(false);
    expect(promptGates(noAsk, false).decideAlone).toBe(false);
  });
});

// Self-awareness (#531): agent and plan know they run inside reika and where its docs are; the
// secrets file and the binary are never named, since pointing at either is an invitation to use it.
describe('reika self line (#531)', () => {
  const line = reikaSelfLine();

  it('rides the agent and plan prompts, not minimal or chat', () => {
    expect(buildSystemPrompt({ bundle, mode: 'agent' })).toContain(line);
    expect(buildSystemPrompt({ bundle, mode: 'plan' })).toContain(line);
    expect(buildSystemPrompt({ bundle, mode: 'agent', minimal: true })).not.toContain('reika');
    expect(buildSystemPrompt({ bundle, mode: 'chat' })).not.toContain('reika');
  });

  it('REIKA_SELF_AWARE=0 drops it from both prompts', () => {
    process.env.REIKA_SELF_AWARE = '0';
    try {
      expect(buildSystemPrompt({ bundle, mode: 'agent' })).not.toContain('reika');
      expect(buildSystemPrompt({ bundle, mode: 'plan' })).not.toContain('reika');
    } finally {
      delete process.env.REIKA_SELF_AWARE;
    }
  });

  it('scopes itself to questions about reika', () => {
    expect(line).toContain('Only if the user asks about reika itself');
  });

  it('points at the shipped docs, and names none when they are missing', () => {
    expect(line).toMatch(/reference docs are in .*docs/);
    expect(reikaSelfLine(null)).not.toContain('docs');
    expect(reikaSelfLine(null)).toContain('~/.config/reika/skills/');
  });

  it('never names the env file, the browser profile or the binary', () => {
    expect(line).not.toContain('.env');
    expect(line).not.toContain('chrome');
    expect(line).not.toMatch(/dist|cli\.js|reika -p/);
  });
});
