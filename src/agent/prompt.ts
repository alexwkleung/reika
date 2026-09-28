import type { ContextBundle } from '../types.js';
import { DOCS_DIR, VERSION } from '../version.js';

export type PromptMode = 'agent' | 'chat' | 'plan';

export function buildSystemPrompt(opts: {
  bundle: ContextBundle;
  mode?: PromptMode;
  planMode?: boolean;
  // Minimal mode (#391). Deliberately a flag on the agent prompt rather than a fourth PromptMode:
  // the loop has six `promptMode === 'agent'` branches (plan-handoff distill, seedPlanProgress, the
  // plan done-gate), and a new mode value would switch all of them off silently — the opposite of
  // "context management stays the same, only the tools and upfront context are chopped off". So
  // minimal runs as an agent turn in every respect except this prompt and its tool list.
  minimal?: boolean;
  // Grind mode (#556). A flag on the agent prompt for minimal's reason: the loop's agent-mode
  // machinery (gates, loop ladders, compaction) must keep running unchanged under it.
  grind?: boolean;
  // Whether `ask_user` is in this turn's tool list. Subagents run without it (see makeSpawnSubagent),
  // and neither the agent nor the plan prompt may point a model at a tool it does not have — the
  // same coupling the plan prompt keeps with planTools for bash (#109).
  canAsk?: boolean;
  // Unattended with no ask_user (#526): nobody can answer, so the ask rule's slot says to decide and
  // say so. The judgment calls are the one part of an unattended run only the model knows about —
  // declines the harness reports itself. Never true alongside canAsk.
  decideAlone?: boolean;
  // Whether `subagent` is in this turn's tool list. Same coupling: subagents run without it (no
  // recursion) and plan mode never has it, so neither may be pointed at it.
  canSubagent?: boolean;
  // Whether this turn's bash actually runs sandboxed (#163): the flag AND a working sandbox-exec AND
  // bash in the list. On Linux or under REIKA_SANDBOX=0 the sentence would tell the model a genuine
  // DNS failure "may be the sandbox" — the misattribution the footer is gated on output to avoid.
  sandbox?: boolean;
  // Which web tools the sandbox sentence may route to. Minimal mode and an offline session have
  // neither, and naming one there is the #377 phantom pointer.
  canFetch?: boolean;
  canSearch?: boolean;
}): string {
  const mode = opts.mode ?? 'agent';
  if (mode === 'chat') {
    return buildChatPrompt(opts.bundle);
  }
  if (mode === 'plan') {
    return buildPlanPrompt(opts.bundle, opts.canAsk, opts.decideAlone);
  }
  if (opts.minimal) {
    return buildMinimalPrompt(opts.bundle, opts.canAsk, opts.decideAlone);
  }
  if (opts.grind) {
    return buildGrindPrompt(opts);
  }
  return buildAgentPrompt(opts);
}

// Minimal mode (#391): the shell, and no project information at all. No projectSummary, no repoMap,
// no instructions — that omission IS the mode, so this function takes the bundle only for its cwd.
//
// The rules are written from scratch rather than filtered down from buildAgentPrompt, because
// almost every agent rule names something that does not exist here: rule 2 is grep, rule 3 is the
// `NNNNN│` gutter contract between `read` and `edit`, rule 6 is about registries and the read tool.
// A filtered list would have left the model with the two vaguest rules and none of the concrete
// ones. What survives is what is actually mode-independent:
//
//  - Rule 1 is the agent prompt's rule 1, unchanged in substance: ground every claim in a command,
//    never answer from general knowledge. It matters MORE here, not less — with no repo map the
//    model has nothing but its priors to confabulate from, and this is the mode where a confident
//    wrong path costs a whole round.
//  - Rule 2 is the orientation step the other modes get for free from the bundle. Stated as a first
//    move rather than a suggestion: the observed failure of a context-less model is not that it
//    explores badly, it is that it starts editing a file it guessed the path of.
//  - Rule 3 is the read-before-write rule, re-expressed for the shell. `cat` before a heredoc is
//    the same contract as read-before-edit, and it is the one the harness cannot enforce here (the
//    read-first gate keys on the edit tool, which is absent).
//  - Rule 4 is the recovery rule, narrowed to what recovery means with one tool: a different
//    command, not a different tool.
//  - Rule 5 is the ask_user permission, kept verbatim from the agent prompt and gated on the tool
//    exactly as it is there.
function buildMinimalPrompt(
  bundle: ContextBundle,
  canAsk?: boolean,
  decideAlone?: boolean,
): string {
  const rules: string[] = [
    "For any question about this project's code, you MUST run a command and read its output before answering. Never describe code from general knowledge — you have been given no project information, so anything you have not looked at you do not know.",
    'You are starting blind. Before anything else, orient yourself: list the directory, then read the files that matter. Never guess a path, a filename, or an extension — check that it exists first.',
    'Before you change a file, read it (`cat`, or `sed -n` for a range). Write it back with a heredoc, `sed -i`, or a redirect. Never rewrite a file you have not just read.',
    'If a command fails, do not give up — try a different command. A missing tool, a wrong path, or an empty result is information, not a dead end.',
    ...(canAsk
      ? [
          'Stopping to ask is a legitimate outcome, not a failure to try harder: when what you have read contradicts the request, use ask_user instead of silently picking one reading.',
        ]
      : decideAlone
        ? [DECIDE_ALONE_RULE]
        : []),
  ];
  return [
    [
      'You are a coding assistant operating in a terminal. Be concise.',
      'You have one tool: a shell. Everything you do goes through it.',
      'Rules:',
      ...rules.map((r, i) => `${i + 1}. ${r}`),
    ].join('\n'),
    `Working directory: ${bundle.cwd}`,
  ].join('\n\n');
}

// Grind mode (#556): the steps a strong model takes on its own, written down as a
// procedure for a model that may not. Two choices carry it:
//
//  - Steps, not dispositions. "Be thorough, question everything" gives a model an attitude to act
//    out, and on a small model that is long anxious reasoning — the spiral the converge steer exists
//    to stop ("do not question yourself" converged where unsteered attempts spiraled). Each step
//    here is something the model does and a transcript shows, so adherence can be graded per step.
//  - Verify by running, not by re-thinking. The loop detectors key on repeated reasoning, not on
//    varied commands, so checking that lands in bash output reads as progress to the harness and
//    they stay on unchanged. When they fire anyway, the model turned "check it" into rumination,
//    which is itself the finding.
//
// Project context stays in: step 2 is "look before you act", and the bundle is where that starts.
function buildGrindPrompt(opts: {
  bundle: ContextBundle;
  canAsk?: boolean;
  decideAlone?: boolean;
  sandbox?: boolean;
}): string {
  const steps: string[] = [
    'Pin down the task. Before your first tool call, state in a sentence or two what "done" means and anything ambiguous about the request.',
    'Look before you act. Find the code involved (grep through bash), read it, find how this codebase already handles similar things, and find the tests that cover it. Never guess a path.',
    'Choose deliberately. Name at least two ways to do it and pick one, in a sentence, saying why.',
    'Make the smallest change that does the job. Read a file before you edit it. read output prefixes each line with `NNNNN│` — that gutter is NOT part of the file; copy only the text after `│` into old_string, verbatim including indentation.',
    'Prove it by running something. Run the existing tests. Then write and run a quick check for the edge cases your change touches — empty input, boundaries, error paths, whatever this task makes risky. Put throwaway checks in a temp dir (`mktemp -d`), not the project. A check you only reasoned through does not count. If a check fails, fix the code and run it again: that loop is the work, not a failure.',
    'Review your own diff. Run `git diff`, reread it as a reviewer would, and check the callers of anything whose behavior changed.',
    'Report honestly. In your final reply, say what you verified by running it, what you did not verify, and what is still uncertain.',
  ];
  const rules: string[] = [
    "Ground every claim about this project's code in something you ran or read. Never describe code from general knowledge.",
    'Verify by running, not by re-thinking. When you notice yourself re-deriving something a command could check, run the command instead, and do not repeat an analysis you already did.',
    'Scale the steps to the task: for a one-line fix, steps 3 and 6 can be a sentence each, but never skip step 5. For a question rather than a change, do steps 1, 2 and 7.',
    'If a command or an edit fails, try a different approach. A failure is information, not a dead end.',
    ...(opts.canAsk
      ? [
          'Stopping to ask is a legitimate outcome, not a failure to try harder: when what you have read contradicts the request, use ask_user instead of silently picking one reading.',
        ]
      : opts.decideAlone
        ? [DECIDE_ALONE_RULE]
        : []),
  ];
  const parts: string[] = [
    [
      'You are a coding assistant operating in a terminal, in GRIND MODE: the work is not done until you have checked it. Be concise in what you write and thorough in what you run.',
      'Your tools: bash for searching, building, testing and everything else; read to view a file; edit to change one.',
      ...(opts.sandbox ? [sandboxSentence(false, false)] : []),
      'Work through these steps, in order:',
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      'Rules:',
      ...rules.map(r => `- ${r}`),
    ].join('\n'),
    `Working directory: ${opts.bundle.cwd}`,
    ...selfLineParts(),
  ];
  if (opts.bundle.projectSummary) parts.push(`Project:\n${opts.bundle.projectSummary}`);
  if (opts.bundle.repoMap) parts.push(`Repo map:\n${opts.bundle.repoMap}`);
  if (opts.bundle.instructions) parts.push(`Project instructions:\n${opts.bundle.instructions}`);
  return parts.join('\n\n');
}

// EXPERIMENT (plan mode): read-only exploration that must converge on a written plan. The
// stopping condition is stated explicitly — weak models in a read-only mode have no natural
// closure signal (no edit to mark "done"), so the prompt has to supply one. The loop appends
// a deterministic exploration ledger + escalating convergence nudge to this; see loop.ts.
function buildPlanPrompt(bundle: ContextBundle, canAsk?: boolean, decideAlone?: boolean): string {
  // Must track planTools(). Telling a model a tool "will fail" while it sits in the tool list is
  // worse than saying nothing — it won't reach for one it has been told is absent. The `=0` text
  // is the pre-#109 prompt byte-for-byte, so the baseline arm A/Bs against an unchanged prompt.
  const planBash = process.env.REIKA_PLAN_BASH !== '0';
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
      // Priced against what a wrong reading costs: the plan is handed to an implementation turn
      // (vibe chains straight into one; plan mode hands it to /implement), and although a refinement
      // turn exists (#46), it costs the user a round trip and a re-read of everything the model
      // already had. So the ask is worth its line here (#272) — but it is a different line from the
      // agent prompt's rule 7. That one is permission (a counterweight to "never give up"); this one
      // is a routing rule, and it is pinned to the plan on both sides — "before writing the plan",
      // "then write the plan" — because every other rule above pulls toward converging on a written
      // plan, and a bare permission-to-pause would hand a stalling model a new way not to write one.
      // The refinement turn's own instruction does not live here: it is a fact about the history
      // (a plan is already written), which this builder never sees — it rides the per-round plan
      // ledger instead (loop.ts buildPlanLedger). Gated on the tool being present, same as rule 7:
      // pointing a model at a tool it does not have is worse than saying nothing.
      ...(canAsk
        ? [
            '5. If the request could be planned two different ways — a choice of approach, of scope, or of where the change belongs — and the code you have read does not settle it, use ask_user ONCE, before writing the plan, then write the plan for the answer.',
            '   Never ask what grep/read could tell you, and never ask instead of writing the plan.',
          ]
        : decideAlone
          ? [
              '5. No one can answer questions this session: if the request could be planned two different ways and the code does not settle it, plan for the most reasonable reading and state that choice at the top of the plan.',
            ]
          : []),
    ].join('\n'),
    `Working directory: ${bundle.cwd}`,
    ...selfLineParts(),
  ];
  if (bundle.projectSummary) parts.push(`Project:\n${bundle.projectSummary}`);
  if (bundle.repoMap) parts.push(`Repo map:\n${bundle.repoMap}`);
  if (bundle.instructions) parts.push(`Project instructions:\n${bundle.instructions}`);
  return parts.join('\n\n');
}

function sandboxSentence(canFetch: boolean, canSearch: boolean): string {
  const route = [
    canFetch ? 'use fetch_url for a web page' : '',
    canSearch ? 'search for a query' : '',
  ].filter(Boolean);
  return (
    'Some shell commands run in a local sandbox: writes are confined to the working directory, temp ' +
    'and cache dirs, and network access is denied except for git and gh. If a command fails with a ' +
    'connection or permission error it may be the sandbox rather than your command — ' +
    (route.length > 0 ? `${route.join(' and ')}, and ` : '') +
    'tell the user when a command genuinely needs the network.'
  );
}

// The ask rule's counterpart when nobody can answer (#526): the choice still gets made, so it
// must at least be visible afterwards.
const DECIDE_ALONE_RULE =
  'No one can answer questions this session: when the request is ambiguous or the code contradicts it, pick the most reasonable reading, carry on, and name each such choice in your final reply.';

function buildAgentPrompt(opts: {
  bundle: ContextBundle;
  planMode?: boolean;
  canAsk?: boolean;
  decideAlone?: boolean;
  canSubagent?: boolean;
  sandbox?: boolean;
  canFetch?: boolean;
  canSearch?: boolean;
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
  // Grind mode's step 6 on its own (#556). Every agent-mode miss on the chunk fixtures was a run that
  // never opened the caller; with this line deepseek-v4.1-flash went 4/10 → 10/10 and a local 27B
  // started searching for callers (0/3 → 2/3), with no extra calls on the fixtures that have none.
  // On by default since 2026-09-27; `=0` is the baseline arm and restores the prompt byte-for-byte.
  const callerCheck = process.env.REIKA_CALLER_CHECK !== '0';
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
    ...(callerCheck
      ? [
          'After you change what a function accepts, returns or throws, find every place that calls it and read each one: check it still works with the new behavior, and fix any you break.',
        ]
      : []),
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
      : opts.decideAlone
        ? [DECIDE_ALONE_RULE]
        : []),
  ];
  const parts: string[] = [
    [
      'You are a coding assistant operating in a terminal. Be concise.',
      // Stated once, in the fixed part, because nothing else announces the sandbox (#163). Without
      // it the model's only evidence is error text, and Seatbelt's network denials are exactly the
      // text that gets misread: "Couldn't connect to server" reads as a dead host, git's "check your
      // access rights" as a missing key, npm's "check your proxy config" as a config problem. A
      // sentence here is what turns those into "this is the sandbox" — the footer in bash.ts is the
      // same fact arriving at the moment of failure. Says what it CANNOT do, not that it is watched:
      // the point is routing to fetch_url/search, not deterrence. Absent when nothing is sandboxed.
      ...(opts.sandbox ? [sandboxSentence(opts.canFetch ?? true, opts.canSearch ?? true)] : []),
      'Rules:',
      // Numbered at join time so an optional rule shifts the ones after it — no gaps, no duplicates.
      ...rules.map((r, i) => `${i + 1}. ${r}`),
    ].join('\n'),
    `Working directory: ${opts.bundle.cwd}`,
    ...selfLineParts(),
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

// Self-awareness (#531): a model asked about reika itself otherwise answers from its priors. Scoped
// "only if asked" because on a small model a named path is an attractor for unrelated exploration.
// Deliberately omitted: `~/.config/reika/.env` (API keys — naming it invites a `cat` that lands
// them in context and the saved transcript), the chrome profile, and the binary (`reika -p` from
// bash is a nested agent outside the subagent cap).
// `REIKA_SELF_AWARE=0` is the baseline arm: the prompt without the line, byte-for-byte.
function selfLineParts(): string[] {
  return process.env.REIKA_SELF_AWARE === '0' ? [] : [reikaSelfLine()];
}

export function reikaSelfLine(docsDir: string | null = DOCS_DIR): string {
  const where = [
    ...(docsDir ? [`its reference docs are in ${docsDir}`] : []),
    'user skills in ~/.config/reika/skills/ (project skills in .reika/skills/)',
    'saved sessions in ~/.config/reika/history/',
  ];
  return `You are running inside reika ${VERSION}. Only if the user asks about reika itself: ${where.join(', ')}.`;
}

function buildChatPrompt(_bundle: ContextBundle): string {
  return [
    'You are a helpful assistant running in a terminal chat. Be concise and direct.',
    "You do not have access to the user's filesystem or shell in this mode. If web-search tools are available, use them only when the answer requires current information or external documentation.",
  ].join('\n\n');
}
