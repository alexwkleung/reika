import type { ContextBundle } from '../types.js';

export type PromptMode = 'agent' | 'chat' | 'plan';

export function buildSystemPrompt(opts: {
  bundle: ContextBundle;
  mode?: PromptMode;
  planMode?: boolean;
  // Whether `ask_user` is in this turn's tool list. Subagents run without it (see makeSpawnSubagent),
  // and neither the agent nor the plan prompt may point a model at a tool it does not have — the
  // same coupling the plan prompt keeps with planTools for bash (#109).
  canAsk?: boolean;
  // Whether `subagent` is in this turn's tool list. Same coupling: subagents run without it (no
  // recursion) and plan mode never has it, so neither may be pointed at it.
  canSubagent?: boolean;
}): string {
  const mode = opts.mode ?? 'agent';
  if (mode === 'chat') {
    return buildChatPrompt(opts.bundle);
  }
  if (mode === 'plan') {
    return buildPlanPrompt(opts.bundle, opts.canAsk);
  }
  return buildAgentPrompt(opts);
}

// EXPERIMENT (plan mode): read-only exploration that must converge on a written plan. The
// stopping condition is stated explicitly — weak models in a read-only mode have no natural
// closure signal (no edit to mark "done"), so the prompt has to supply one. The loop appends
// a deterministic exploration ledger + escalating convergence nudge to this; see loop.ts.
function buildPlanPrompt(bundle: ContextBundle, canAsk?: boolean): string {
  // Must track planTools(). Telling a model a tool "will fail" while it sits in the tool list is
  // worse than saying nothing — it won't reach for one it has been told is absent. The default text
  // is left byte-identical so the flag A/Bs against an unchanged prompt.
  const planBash = process.env.REIKA_PLAN_BASH === '1';
  const parts: string[] = [
    [
      'You are a coding assistant in PLAN MODE, operating in a terminal. Be concise.',
      ...(planBash
        ? [
            'You can ONLY explore the codebase — read, list, grep, glob, and READ-ONLY shell',
            'commands through bash. You CANNOT edit or write files; those tools are not available',
            'and will fail, and bash refuses any command that could write or run something else.',
          ]
        : [
            'You can ONLY explore the codebase — read, list, grep, glob. You CANNOT edit, write,',
            'or run commands; those tools are not available and will fail.',
          ]),
      'Your job: explore just enough to understand the change, then STOP and write a plan.',
      'Rules:',
      `1. Use ${planBash ? 'grep/read/list/glob/bash' : 'grep/read/list/glob'} to ground every claim in the actual code. Never guess.`,
      '2. Explore only what you need. The moment you can describe the steps, STOP exploring.',
      '3. Do NOT re-read or re-grep something you already examined — act on what you have.',
      '4. End by writing a numbered, file-specific plan of the steps to make the change.',
      '   Each step names the file and what changes. Do not write any code — just the plan.',
      // Plan mode is a one-shot pass: the plan it writes is handed straight to an implementation
      // turn with no refinement round in between (#46 is still open), so a plan built on the wrong
      // reading of the request costs the whole implementation turn, not one edit. That makes the ask
      // worth its line here (#272) — but it is a different line from the agent prompt's rule 7. That
      // one is permission (a counterweight to "never give up"); this one is a routing rule, and it is
      // pinned to the plan on both sides — "before writing the plan", "then write the plan" — because
      // every other rule above pulls toward converging on a written plan, and a bare
      // permission-to-pause would hand a stalling model a new way not to write one. Gated on the tool
      // being present, same as rule 7: pointing a model at a tool it does not have is worse than
      // saying nothing.
      ...(canAsk
        ? [
            '5. If the request could be planned two different ways — a choice of approach, of scope, or of where the change belongs — and the code you have read does not settle it, use ask_user ONCE, before writing the plan, then write the plan for the answer.',
            '   Never ask what grep/read could tell you, and never ask instead of writing the plan.',
          ]
        : []),
    ].join('\n'),
    `Working directory: ${bundle.cwd}`,
  ];
  if (bundle.projectSummary) parts.push(`Project:\n${bundle.projectSummary}`);
  if (bundle.repoMap) parts.push(`Repo map:\n${bundle.repoMap}`);
  if (bundle.instructions) parts.push(`Project instructions:\n${bundle.instructions}`);
  return parts.join('\n\n');
}

function buildAgentPrompt(opts: {
  bundle: ContextBundle;
  planMode?: boolean;
  canAsk?: boolean;
  canSubagent?: boolean;
}): string {
  // EXPERIMENT (#273): the subagent tool has carried its own trigger (">3 files, long reference
  // chains") since it was added, and the debug logs show it never gets called. The tool's real
  // value here is context: N reads through a subagent land in the parent as ONE digest payload
  // instead of N, and payload crowding is what evicts the task spec on a small window (#276).
  //
  // This is a ROUTING rule, not permission, and it sits at rule 3 rather than the tail — both by
  // measurement. The first arm was permission-shaped in rule 7's image ("when answering needs more
  // than ~3 files, hand it to subagent") at the end of the list: 0/2 uptake on qwen3.8-27b, and the
  // reasoning never mentioned the tool. Its trigger was a forecast — how many files WILL this need —
  // and this class of model does not plan that way; it takes the obvious next step, which is rule 2,
  // and once mid-exploration rules 2–3 keep it there. Rule 7 works because its trigger is an
  // observation. So the trigger here is the request's shape, observable at round 0, and the line sits
  // next to rule 2 because that is what the model did at round 0. The same runs showed the model
  // listing the five files it needed by name before its first call — the task string a subagent
  // needs is something it can already write. Scoped to exploration on purpose: a delegated edit is
  // one the parent never read the file for. "Not line numbers": the arm-2 parent asked its subagent
  // for "exact line references" unprompted, and pinning line numbers for type fields is what drove
  // the subagent to read types.ts in 14 slices (#340, #341) — the precision costs reads and the
  // chain doesn't need it. The closing sentence is the guard against over-application on one-file
  // questions. Flagged so it A/Bs against a byte-identical prompt; read per call so toggling it
  // doesn't need a restart.
  const subagentNudge = opts.canSubagent && process.env.REIKA_SUBAGENT_NUDGE === '1';
  const rules: string[] = [
    "For any question about this project's code, you MUST use tools before answering. Never describe code from general knowledge.",
    'To find where something is defined, use grep for the symbol name. Do NOT guess file paths or extensions.',
    ...(subagentNudge
      ? [
          'When the request is to trace, explain, or summarize how something works across several files, your FIRST tool call is subagent: give it the question plus every path and symbol you already know, and ask for the chain with file and function names, not line numbers. Its reads stay out of your context and its report counts as tool output. A question one or two files answer, read yourself.',
        ]
      : []),
    'Before edit, read the file to see exact text. read output prefixes each line with `NNNNN│` — that gutter is NOT part of the file; copy only the text after `│` into old_string, verbatim including indentation.',
    'If a tool call fails, do not give up — try a different tool (grep, list, read) to recover.',
    'Only the listed tools exist. Use their exact names.',
    'Before creating a new file in an existing directory, OR adding to a registry/list/array, you MUST read at least one existing example to learn its shape and exact exported interface. Never invent a structure.',
    // Counterweight to rule 4, which is why it earns its tokens rather than restating the tool's
    // own description. Every rule above pushes one way — recover, keep going, don't give up — and
    // in that frame stopping to ask reads as giving up. The trigger lives in the ask_user
    // description (that is what a model consults when choosing a tool); this is the permission,
    // and permission is what a model needs BEFORE it is stuck. A directive would not help after:
    // the class of model that ignores the withdrawal ledger cannot act on directives either.
    ...(opts.canAsk
      ? [
          'Stopping to ask is a legitimate outcome, not a failure to try harder: when the code you have read contradicts the request, use ask_user instead of silently picking one reading.',
        ]
      : []),
  ];
  const parts: string[] = [
    [
      'You are a coding assistant operating in a terminal. Be concise.',
      'Rules:',
      // Numbered at join time so an optional rule shifts the ones after it — no gaps, no duplicates.
      ...rules.map((r, i) => `${i + 1}. ${r}`),
    ].join('\n'),
    `Working directory: ${opts.bundle.cwd}`,
  ];
  if (opts.bundle.projectSummary) {
    parts.push(`Project:\n${opts.bundle.projectSummary}`);
  }
  if (opts.bundle.repoMap) {
    parts.push(`Repo map:\n${opts.bundle.repoMap}`);
  }
  if (opts.bundle.instructions) {
    parts.push(`Project instructions:\n${opts.bundle.instructions}`);
  }
  if (opts.planMode) {
    parts.push('Plan mode: describe your approach first. Do not modify files.');
  }
  return parts.join('\n\n');
}

function buildChatPrompt(_bundle: ContextBundle): string {
  return [
    'You are a helpful assistant running in a terminal chat. Be concise and direct.',
    "You do not have access to the user's filesystem or shell in this mode. If web-search tools are available, use them only when the answer requires current information or external documentation.",
  ].join('\n\n');
}
