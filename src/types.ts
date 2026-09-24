import type { Ignore } from 'ignore';
import type { Skill } from './skills.js';

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type Message =
  // `meta` marks a UI-only echo of a slash command (e.g. `/model`, `/stats`): shown in the
  // scrollback as the user's input but never sent to the model — its system response is
  // already dropped, so a bare command turn would just be redundant context.
  | {
      role: 'user';
      content: string;
      display?: string;
      nested?: boolean;
      meta?: boolean;
      // Authored by the harness, not typed by the human: a recovery nudge that must REACH the model
      // (so it cannot be `meta`, which is dropped from the request) but is not a turn boundary. The
      // task-spec pin elects "the first tool payload after the newest real user message" (#227), so
      // without this a nudge re-elects the spec to whatever result lands next. Measured on the
      // continuation arm: the pin moved off `gh issue view 244` onto a 126-char grep result, then a
      // 47-char heredoc echo, exactly two rounds after each nudge — and the model then correctly
      // re-fetched the issue, which is the #251/#252 cascade the nudge exists to avoid.
      harness?: boolean;
      // Which mode the turn this prompt opened actually ran in. Stamped by the UI on real turns
      // only (never on `meta` command echoes, which happen between turns), so a saved transcript
      // says what each turn was — a plan turn and an agent turn look identical otherwise. Vibe
      // turns are stamped 'vibe' rather than their internal plan→agent phases. See
      // store/transcript.ts summarizeModes.
      mode?: Mode;
      // Name of the skill this turn was opened with (typed `/name`, or auto-injected by skill
      // routing). Stamped at submit, where it is known — nothing downstream can infer it, since a
      // skill turn's content is just the skill body. Compaction reads it to tell a MANDATED opening
      // call (`/issue`, `/review` both fetch the spec first, so the turn's first tool result really
      // is the task) from an arbitrary one elected by position, and only makes the strong "this is
      // the task" claim over the former (#275).
      skill?: string;
    }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      reasoning?: string;
      durationMs?: number;
      sources?: string[];
      nested?: boolean;
      // UI-only (#280): this message is a compaction note — the reply to the report round before a
      // fold, drawn at the left edge as one info-barred block (reasoning, then the note) so it reads
      // as a harness aside — not the answer, and not a subagent (#498). Never enters model history.
      compactionNote?: boolean;
      // Set only on the plan-mode force-write final message — the verbatim anchor the
      // agent-handoff distillation pins on (agent/compaction.ts distillPlanHandoff). Never
      // set in agent or chat mode.
      planFinal?: boolean;
      // EXPERIMENT (REIKA_PREFIX_STABLE): reasoning dropped from requests by batch aging. Sticky
      // on the shared message object so the boundary — and the inference engine's prompt-cache
      // prefix — holds across rounds and turns. See agent/compaction.ts batchAgePayloads.
      reasoningAged?: boolean;
      // EXPERIMENT (REIKA_CONTINUE, #284): this assistant message carries the trimmed tail of a
      // reasoning block that was cut off mid-thought, promoted into `content` so the chat template
      // renders it (prior-turn `reasoning_content` is dropped by Qwen-family templates). Marks it
      // for the aging sweep: protected while the continuation it feeds is live, then the FIRST
      // thing shed once spent — the same "the model can't re-fetch its own reasoning" logic that
      // ages reasoning first, which applies again the moment the tail has done its job.
      continuationTail?: boolean;
    }
  | {
      role: 'tool';
      callId: string;
      summary: string;
      payload?: string;
      payloadId?: string;
      // EXPERIMENT (REIKA_PREFIX_STABLE): `aged` = payload collapsed to summary by batch aging
      // (sticky; replaces the per-round trailing-block collapse while the flag is on). `rendered` =
      // the exact bytes this payload was first serialized with, reused verbatim while live so a
      // drifting payload cap can't rewrite mid-history bytes and invalidate the engine's prefix
      // cache; cleared when the message ages. See provider/toolcall.ts + agent/compaction.ts.
      aged?: boolean;
      rendered?: string;
      diff?: { text: string; path: string; added: number; removed: number; startLine?: number };
      command?: { text: string; outputTail: string; outputTruncated: boolean };
      // See ToolResult.changes.
      changes?: TreeChanges;
      // See ToolResult.exitCode. Rides the message so plan progress can be re-derived from history
      // (agent/plantrack.ts replays it) rather than re-parsed out of the summary text. Absent on
      // every non-bash result and on transcripts written before #200.
      exitCode?: number | null;
      nested?: boolean;
    }
  | { role: 'error'; content: string; nested?: boolean }
  // `tone` styles the scrollback marker: undefined = default (accent ❯), 'info' = a routine
  // automatic event (compaction), 'warn' = an automatic recovery the user should notice
  // (truncation retry). Distinguishes harness-generated notices from each other and from
  // the user's own input.
  | {
      role: 'system';
      content: string;
      tone?: 'info' | 'warn';
      nested?: boolean;
      // Set only on the plan done-gate's give-up notice: the step numbers waived after the model
      // was bounced once and finished anyway. The plan tracker recomputes from history each turn
      // (agent/plantrack.ts seedPlanProgress), so the waiver must ride a message to survive —
      // without it every later turn would re-bounce the same adjudicated step.
      planWaived?: number[];
      // About this launch rather than the conversation — the startup notices, the exit summary.
      // Left out of the auto-save (#1), or every resume would replay them and stack a new set.
      skipAutosave?: boolean;
    }
  // A deterministic recap that replaces an older span of history once context nears the
  // window. Lives only in the model-facing history (merged into the system prompt by
  // messagesToChatParams); the UI keeps the full scrollback separately.
  | { role: 'compaction'; content: string; nested?: boolean }
  | { role: 'shell'; command: string; output: string; nested?: boolean };

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  // Prompt tokens served from the provider's cache. Populated when the provider
  // reports it (OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
  // `prompt_cache_hit_tokens`); undefined means the provider didn't report it.
  cachedTokens?: number;
};

// One generated token as the provider reported it, with the alternatives it was sampled against.
// Populated only when the request asked for logprobs (REIKA_ENTROPY, issue #134); the drift
// instrumentation in agent/entropytrace.ts is the sole consumer. `top` is the engine's truncated
// top-k, so the probabilities it carries do NOT sum to 1 — the missing tail mass is measured, not
// assumed away. Normalized here (camelCase, non-nullable) so the wire's snake_case/null variants
// stop at the provider boundary.
export type SampledToken = {
  token: string;
  // Natural log of the probability the model assigned to the token it actually emitted.
  logprob: number;
  // The top-k candidates at this position, when the engine returned them (top_logprobs).
  top?: { token: string; logprob: number }[];
};

// One file a bash command changed, as the UI draws it. `hunks` is empty for a binary file; past
// the per-file row cap the rest is counted in `omitted` rather than drawn.
export type FileChange = {
  // Relative to the session cwd — `../` when the command reached elsewhere in the repo.
  path: string;
  // `rewritten`: modified, but sharing too little with its previous bytes for a diff to be worth
  // computing (tools/_diff.ts MAX_EDIT_LENGTH); no hunks, and the counts are the two files' sizes.
  kind: 'modified' | 'created' | 'deleted' | 'binary' | 'rewritten';
  hunks: DiffHunk[];
  added: number;
  removed: number;
  omitted?: number;
};

// Same `+ `/`- `/`  ` line format as an edit's diff, with both files' starting line numbers so a
// gutter can number removed lines by the old file and the rest by the new one.
export type DiffHunk = { text: string; startLine: number; oldStartLine: number };

// The changed files that got a diff, and how many more changed past the cap.
export type TreeChanges = { files: FileChange[]; more: number };

export type ToolResult = {
  summary: string;
  payload?: string;
  display?: string;
  diff?: { text: string; path: string; added: number; removed: number };
  command?: { text: string; outputTail: string; outputTruncated: boolean };
  // What a `bash` command did to the working tree, for the UI to draw as diffs the way `diff`
  // draws an edit (#278). Set only when git saw a file change under the command. Display-only,
  // like `diff`: never serialized into a request. See tools/_treediff.ts.
  changes?: TreeChanges;
  // The process's exit status, straight from node's 'close' event: a number, or null when a signal
  // killed it. Set by `bash` only, and only once a process actually ran — undefined means "no
  // status to report" (every other tool, and a spawn that never got off the ground), which is what
  // lets consumers fall back to the old summary-prefix reading for results that predate the field.
  // Carried as data because the summary is the wrong place to answer "did this succeed?": a
  // non-zero exit is ordinary control flow (grep with no match, a red test run) and is reported as
  // a plain `Ran:` line, so the prefix no longer implies success. See tools/bash.ts and #200.
  exitCode?: number | null;
  // Hash of the whole file the read covered. Set only by `read`; lets the loop's ReadTrace
  // tell a re-read of unchanged content from a legitimate refetch after the file changed,
  // without a second disk read. Keyed on the full file (not the slice) so a window-varying
  // re-read of the same region still hashes identically. See agent/readtrace.ts.
  contentHash?: string;
  // A user-facing receipt for a harness side effect the tool performed (e.g. URL grounding fetching
  // a link). The loop emits it as a standalone `system` scrollback line AFTER the tool's own chip,
  // so it reads as a follow-on to the action rather than being stuffed in front of it. `warn` for an
  // outcome worth noticing (a dead link), `info` for a quiet "this ran".
  notice?: { tone: 'info' | 'warn'; content: string };
  // Structured non-apply outcome from `edit`. The tool already computes the closest matching block
  // and the exact divergent line for its summary hint; surfacing it as data lets the agent loop lift
  // that grounding into a persistent, non-aging recovery directive (the summary string rides in the
  // tool result, which ages out under compaction) and tell a recoverable content divergence
  // ('diverged') from a genuinely-absent anchor ('absent'). See tools/edit.ts and agent/loop.ts
  // buildEditRecoveryLedger.
  editFailure?: EditFailure;
};

// See ToolResult.editFailure. 'absent': old_string matches nothing in the file even ignoring
// whitespace — no anchor line aligns anywhere. Two very different causes share this shape: the plan
// references code that never existed, OR the model wrote old_string from memory because the file's
// bytes are no longer in its context. Only the caller can tell them apart (agent/readfirst.ts
// isGrounded), which is why the excerpt rides along rather than the failure deciding what to say.
// 'diverged': the anchor block exists and one line differs — mechanically recoverable, which is the
// only case the loop spends a grounded recovery round on.
export type EditFailure =
  | {
      kind: 'absent';
      path: string;
      // Best-guess 1-based line of the region old_string most resembles, from the weakest locator
      // (token overlap — there is no matching line to anchor on), plus that region's verbatim,
      // line-numbered text. Absent when even that finds nothing above its confidence floor.
      at?: number;
      excerpt?: string;
    }
  | {
      kind: 'diverged';
      path: string;
      divergentLine: number; // 1-based file line where old_string first disagrees with the file
      expected: string; // what old_string has on that line (trimmed)
      actual: string; // what the file actually has there (trimmed)
      excerpt: string; // verbatim, line-numbered current text around the block — copyable
    };

export type ApprovalRequest = {
  tool: string;
  subject: string;
  preview: string;
  // 1-based file line number of the first line in `preview`, when it's a diff.
  // Lets the diff view render an editor-style line-number gutter.
  startLine?: number;
  warnings?: string[];
};

// One choice in an `ask_user` question. `label` is the whole answer as far as the model is
// concerned — it is what comes back when the user picks this row, so it must stand alone as a
// sentence. `description` is optional on purpose: a weak model that emits bare labels still
// produces a usable menu, and rejecting the call would push it back to guessing, which is the
// exact failure the tool exists to prevent (#198).
export type QuestionOption = {
  label: string;
  description?: string;
  // At most one option may carry this; the UI marks it and nothing else depends on it.
  recommended?: boolean;
};

export type QuestionRequest = {
  question: string;
  options: QuestionOption[];
};

// What the user actually chose. `index` is undefined when they typed their own answer instead of
// picking a row; `notes` carries free text added on top of a picked row. `text` is the resolved
// answer either way, so a caller that only wants "what did they say" reads one field.
export type QuestionAnswer = {
  text: string;
  index?: number;
  notes?: string;
};

export type WebBudget = {
  searches: { used: number; max: number };
  fetches: { used: number; max: number };
};

// Per-turn latches for the web tools. Shared by reference like webBudget: the object is what
// carries the latch between calls, since a fresh ToolContext is built per tool call.
export type WebHealth = {
  // Set when a search fails for a provider-level reason (see SearchUnavailableError): further
  // searches this turn report it without re-attempting.
  unavailable?: string;
  // Set when a fetch fails with a network-down code (see tools/_net.ts OFFLINE_CODES): the machine
  // has no route out, so every further search and fetch this turn is skipped without a request
  // or a budget slot (#392). Holds the code, for the message.
  offline?: string;
};

export type ToolContext = {
  cwd: string;
  ignore?: Ignore;
  webBudget?: WebBudget;
  // Per-turn latches for the web tools (a provider that refused, a network that is down). Once
  // set, further calls in the turn report the same reason without re-attempting or spending budget.
  webHealth?: WebHealth;
  // Tools push successfully-fetched URLs here; the loop stamps them onto the
  // final assistant message as `sources`, rendered deterministically in scrollback.
  fetchedUrls?: Set<string>;
  // Names of every tool in this turn's list. A tool result must not point the model at a tool it
  // does not have (the coupling the prompts keep through `canAsk`/`canSubagent`): fetch_url's
  // spill locator says "read that path", which in chat mode — fetch_url and search only — is a
  // dead end (#377). Undefined means unknown, and a tool treats unknown as the full agent set.
  toolNames?: ReadonlySet<string>;
  // Dependency package names whose installed type surface has already been injected into a
  // tool result this turn (see tools/_deps.ts). edit/write consult and extend it so each
  // imported dep is grounded at most once per turn — bounded bloat, no re-injection.
  resolvedDeps?: Set<string>;
  // http(s) URLs already grounded (fetched on the model's behalf) this turn (see tools/_urls.ts).
  // Same per-turn dedupe contract as resolvedDeps: each URL a write/edit introduces is fetched at
  // most once, so a follow-up edit to the same file doesn't re-fetch it.
  groundedUrls?: Set<string>;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  // Put a question to the user and wait for their answer (tools/ask.ts). Resolves null when the
  // user dismisses it. Undefined when there is no one to ask — a subagent, a test, a non-interactive
  // run — and the tool degrades to telling the model to proceed on its own judgment rather than
  // hanging on a prompt nobody will see.
  requestQuestion?: (req: QuestionRequest) => Promise<QuestionAnswer | null>;
  // Questions already put to the user this turn, oldest first. Per-turn like resolvedDeps, and
  // mutated by the ask tool. Enforces the one-question cap: a tool that can be called repeatedly is
  // a new loop surface, and the answer to the second question is rarely what was blocking.
  askedQuestions?: string[];
  onProgress?: (chunk: string) => void;
  spawnSubagent?: (opts: { task: string }) => Promise<ToolResult>;
  // Bash bounds, ms, threaded from Config; undefined falls back to the bash tool's own defaults.
  // The ceiling is wall-clock; idle is time without output — the one that catches a hung command.
  bashTimeoutMs?: number;
  bashIdleMs?: number;
  // The turn's abort signal. A running command is killed on it, so ctrl-c reaches the child
  // instead of waiting out whatever bound would have ended it.
  signal?: AbortSignal;
  // Whether bash may sandbox a command (#163), threaded from Config. Undefined means yes — the
  // sandbox is on by default and only `REIKA_SANDBOX=0` turns it off — so a caller that predates the
  // flag (a test, a subagent) gets the default rather than silently opting out.
  sandbox?: boolean;
};

export type ToolParameters = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

export type Tool = {
  name: string;
  description: string;
  parameters: ToolParameters;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};

export type ContextBundle = {
  projectSummary: string;
  repoMap: string;
  instructions: string;
  cwd: string;
  hash: string;
  fileIndex: string[];
  ignore: Ignore;
  skills: Skill[];
};

export type Profile = {
  model: string;
  baseURL: string;
  apiKey: string;
  maxTokens?: number;
  // Total context window of the model, used as the denominator for the context-fill
  // gauge. Undefined when unknown (the gauge then shows absolute tokens, no percentage).
  contextWindow?: number;
  // The window above came from the endpoint's model listing (#417), not the env. It belongs to
  // this profile's model: a profile inheriting from this one must not carry it over.
  contextWindowProbed?: boolean;
  // The model's output cap, from the models.dev catalog (provider/modellimits.ts). Bounds the
  // max_tokens backstop, which otherwise asks a hosted model for more than it can emit. Belongs to
  // this profile's model, like a probed window.
  maxOutputTokens?: number;
  // Generation room reserved from the window, in tokens. Drives the per-turn max_tokens
  // backstop, the fit-to-window payload reserve, and the compaction trigger. Undefined =
  // use DEFAULT_MIN_GEN_TOKENS. See provider/budget.ts.
  minGenTokens?: number;
  // How pasted images reach this profile's model. 'describe' (the default) reads the image into
  // text with the vision model or system OCR, so a text-only model still gets its content;
  // 'native' hands the bytes to the model itself as an image part, for a model that can see.
  // Per-profile because this is a property of the model, not of the machine: the local default
  // stays text-only while `/model <vl>` sends images straight through.
  vision?: VisionRoute;
  // Registered at runtime by `/model <name>` for a model that isn't in the config:
  // connection settings are inherited from the profile active at switch time. The flag
  // keeps the UI honest about the model being off-config (switch message, picker marker).
  adhoc?: boolean;
  // The named profile whose extra model this is (REIKA_<NAME>_MODEL=a,b — `b` is keyed by its
  // own name but belongs to that profile's connection). The picker shows the name so a router's
  // models read as one group; the key stays the model so `/model b` works.
  group?: string;
};

// How much runs without a confirmation prompt.
//   'off'    — confirm every mutating action (the session toggle may still raise this to 'safe').
//   'safe'   — auto-approve ordinary actions, but commands flagged dangerous (see bash.ts danger
//              patterns) still prompt. The warnings break-glass.
//   'bypass' — approve everything, including dangerous commands. True yolo, no prompts at all.
export type AutoApproveMode = 'off' | 'safe' | 'bypass';
// 'off' — a match only earns the one-line hint. 'ask' (default) — the TUI opens the confirm dialog
// (#425); headless, with nobody to ask, sends the prompt as typed. 'apply' — the TUI still asks
// (a human present is never a reason to inject silently), and headless applies a strong match
// without asking, under the tighter 12-word gate.
export type SkillAutoMode = 'off' | 'ask' | 'apply';
// Pasted-URL fetching (#448), the same three values with the same split. A URL that IS the
// request (short prompt, link at the start or end or after a read verb) is fetched under 'ask' and
// 'apply' alike; one that merely appears in the prompt — inside a pasted error, a log line — is
// what the mode decides. 'off' fetches nothing (an airgapped machine). 'ask' (default) — the TUI
// opens the confirm dialog; headless, with nobody to ask, leaves it and says so. 'apply' — the TUI
// still asks, and headless fetches it too, with the private-host policy kept since nobody vouched
// for the address.
export type PasteFetchMode = 'off' | 'ask' | 'apply';

// How a pasted image reaches the model (REIKA_VISION, per-profile as REIKA_<NAME>_VISION).
//   'describe' — read it into text first: a vision model (REIKA_VISION_MODEL) or system OCR
//                writes a description that rides into the prompt as an <image> block. The main
//                model stays text-only, and the description stays in history and is cacheable.
//   'native'   — send the bytes to the main model as an OpenAI multimodal image part, once per
//                turn, for the model that can already see. History keeps a short "not transcribed"
//                note in the block's place instead of a description, so the string-only pipeline
//                (aging, compaction, spill, transcripts) is untouched either way.
export type VisionRoute = 'describe' | 'native';

// What the session is currently doing: which tools and system prompt a turn gets, or (shell)
// whether a turn reaches the model at all. Lives here rather than in ui/commands.ts because
// messages carry it (see Message['user'].mode); ui/commands.ts re-exports it.
export type Mode = 'agent' | 'shell' | 'chat' | 'plan' | 'vibe' | 'minimal';

// Which mode a session starts in (REIKA_DEFAULT_MODE). Only the model-driven work modes are
// eligible — chat isolates history and shell bypasses the model entirely, so neither makes
// sense as a launch default. `minimal` is eligible and is the one people are most likely to
// LAUNCH in rather than switch to: its whole point is skipping the upfront context load, and a
// session that starts in agent mode has already paid for it (#391).
export type DefaultMode = Extract<Mode, 'agent' | 'plan' | 'vibe' | 'minimal'>;

export type Config = {
  baseURL: string;
  apiKey: string;
  model: string;
  // Models served by the default base URL (parsed from a comma-separated REIKA_MODEL).
  // model === models[0]. When more than one is listed, each is also registered as an
  // auto-profile keyed by its lowercased name so /model <name> can switch between them.
  models: string[];
  maxTurns: number;
  repoMapBudget: number;
  autoApprove: AutoApproveMode;
  // True when REIKA_AUTO_APPROVE was set: `safe` is the default when it isn't, and the session
  // toggle (/approvals) has to know whether a `safe` came from the env or from that default.
  autoApproveExplicit?: boolean;
  subagentModel?: string;
  subagentBaseURL?: string;
  subagentApiKey?: string;
  subagentMaxTurns: number;
  // Vision model for pasted/dragged-in images (REIKA_VISION_MODEL, #130). When set, images are
  // described by this model instead of run through system OCR; the description reaches the main
  // model as text, so the main model can stay text-only. Used for nothing else. Base URL and key
  // fall back to the main server, like the subagent settings.
  visionModel?: string;
  visionBaseURL?: string;
  visionApiKey?: string;
  // How pasted images reach the active profile's model (REIKA_VISION, per-profile as
  // REIKA_<NAME>_VISION). Unset means 'describe': read the image into text first. Resolved from
  // the *active profile*, so `/model <vl>` can switch a session over to native image parts and
  // back without restarting. See VisionRoute.
  vision?: VisionRoute;
  searxngUrl?: string;
  // Drive a real Chrome over CDP for web search instead of SearXNG (REIKA_CDP_SEARCH=1, #235).
  // Takes priority when both are configured: SearXNG reaches engines as a bare HTTP client, which
  // is the shape they CAPTCHA — a browser with a persistent profile is the one that stays served.
  cdpSearch?: boolean;
  // Port for Chrome's remote debugging endpoint (REIKA_CDP_PORT). An instance already listening
  // here is reused rather than relaunched.
  cdpPort?: number;
  profiles: Record<string, Profile>;
  maxTokens?: number;
  contextWindow?: number;
  // The active profile's maxOutputTokens, overlaid by resolveProfile.
  maxOutputTokens?: number;
  // Generation room reserved from the window, in tokens (REIKA_MIN_GEN_TOKENS). Drives
  // the per-turn max_tokens backstop, the fit-to-window payload reserve, and the
  // compaction trigger — one number, three call sites. See provider/budget.ts.
  minGenTokens: number;
  // How many recent tool-call rounds keep their reasoning_content in context. Older
  // reasoning is pruned. 1 = only the active roundtrip (leanest); higher keeps the
  // model's chain-of-thought so it doesn't re-derive across rounds, at a token cost.
  reasoningRounds: number;
  maxSearchesPerTurn: number;
  maxFetchesPerTurn: number;
  // Bounds on a single bash command, ms (#408). `bashTimeoutMs` (REIKA_BASH_TIMEOUT_MS) is the
  // wall-clock ceiling, sized for a slow build or a full test suite; `bashIdleMs`
  // (REIKA_BASH_IDLE_MS) kills a command that has written nothing for that long, which is the
  // shape of a hang — a server, a watcher, a prompt — and is what keeps a stuck small model from
  // spending the whole ceiling on it. 0 disables either.
  bashTimeoutMs: number;
  bashIdleMs: number;
  // Preferred OCR languages for pasted images (REIKA_OCR_LANGS, BCP-47, comma-separated).
  // Undefined lets the platform recognizer pick its default (en-US). Windows uses only the
  // first entry. Ignored when a vision model is configured.
  ocrLangs?: string[];
  // What to do with http(s) URLs in a prompt before the turn runs (REIKA_PASTE_FETCH). See
  // PasteFetchMode and agent/pastedurls.ts.
  pasteFetch: PasteFetchMode;
  // Whether model-chosen shell commands run under the local sandbox (`REIKA_SANDBOX`, #163).
  // Default on, macOS only; see tools/bash.ts's composition and tools/_sandbox.ts for the profile.
  sandbox: boolean;
  // Auto-save each TUI session under ~/.config/reika/history/projects/ for /resume
  // (REIKA_AUTOSAVE, default on — see store/sessions.ts). Optional so a hand-built Config (tests)
  // writes nothing to the home directory unless it asks to.
  autosave?: boolean;
  // Whether the harness runs the post-edit typecheck gate (`REIKA_TYPECHECK`, default on — see
  // src/check/typecheck.ts). Off entirely skips the baseline capture, the final re-check, and the
  // done-gate send-backs — not just the retries. The flag exists because not every TypeScript project
  // (slow tsc, heavy monorepo, a stricter gate run by the project's own checks) wants the
  // harness-level checker even when a tsconfig is present, and a fine-grained knob — rounds,
  // timeout, per-turn budget — composes off a switch rather than a feature.
  typecheck?: boolean;
  // Rotate the busy indicator's "Working" through ui/Working.tsx's WORKING_WORDS
  // (REIKA_WORKING_WORDS, default on). Optional so a hand-built Config keeps the fixed label.
  workingWords?: boolean;
  // What a command-shaped skill match may do to the prompt (REIKA_SKILL_AUTO). See parseSkillAuto.
  skillAuto: SkillAutoMode;
  // Replace the current user's git name/email and GitHub/HF account slugs with <user>/<email> in
  // the scrollback and saved transcripts (REIKA_ANON=1, default off). Display only — the model
  // still receives everything verbatim. See ui/identity.ts.
  anon: boolean;
};
