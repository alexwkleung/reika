# Findings

[← README](../README.md)

Reika exists to test one claim: most of what makes a small, heavily quantized local model usable as a
coding agent is not the model. This page is the measured part of that claim — what broke, what was
tried, and what held, running 8–35B models at Q2–Q4 on a 16–32k window.

The numbers come from real sessions and from the eval fixtures, instrumented with `REIKA_DEBUG` log
lines and with A/B arms behind environment flags. [`AGENTS.md`](../AGENTS.md) holds the same record in
the form the agent editing this repo reads it, with file paths, flag names and issue numbers; this page
is the shorter version for people. [How these were measured](#how-these-were-measured) is at the end.

**Setup.** Most local runs are on an M2 MacBook with 16GB of unified memory, through llama.cpp, on the
quants in [Tested models](models.md) — mostly Qwen3.6 35B A3B at IQ2 and Qwen3.8 27B at IQ3. A few
results come from API-hosted models, and those are labeled where they appear: an API model behaves
like a small one in some ways, but it does not reproduce Q2 quantization loss.

**Three words used throughout.** When the request nears the context window, the harness first
_sheds_ old tool output, collapsing each payload to a one-line summary, down to a _watermark_ (a target
fill, 70% of the window). If that is not enough it _folds_: the oldest turns are replaced by one recap
message.

## The harness's own context management cost more than anything the model did

Every layer that buys window room — collapsing old tool payloads to one-line summaries, dropping older
reasoning, regenerating the loop ledgers — rewrites bytes in the middle of the request. An engine caches
the prompt prefix up to the first byte that differs, so a rewrite invalidates everything after it. On
SWA/hybrid-memory models nothing can be partially restored: any divergence re-processes the full prompt.

One mid-context edit, measured on a 27B at 22.9 tok/s prefill:

| Request   | Prefill      | Wall clock |
| --------- | ------------ | ---------- |
| The edit  | 8,453 tokens | 7.9 min    |
| An append | 25 tokens    | 3.5 s      |

`--cache-reuse` on the engine side came out byte-identical, which is what makes this a harness problem
rather than a server setting: the cache is invalidated before the engine gets a say. Prefill is roughly
80% of a turn at that ratio — a measured review turn was 250 s of prefill against 53 s of decode — so
this is most of the wait a user feels.

What changed: **prefix-stable mode** (`REIKA_PREFIX_STABLE`, on by default with a known window) keeps
requests append-only between shrink events. Payload renders are byte-frozen until the estimate crosses
the compaction threshold, and are then shed oldest-first to a 0.7 watermark in the same request
compaction fires in, so one cache invalidation is amortized across an event instead of paid every
round. How deep that watermark should be is still open, and `evals/prefixcost-report.ts` measures it
rather than arguing it.

Two follow-on findings came out of the same accounting:

- **Write the compaction note before the shed.** Written after it, one event paid two full re-prefills —
  measured at the first live fold, 9k + 9.3k tokens, 416 s + 431 s on a 24k window. Written first, the
  note round should be a pure append on the previous round, with the shed and the fold landing together
  on the real request that was going to diverge from the top anyway. That reordering shipped on the
  arithmetic; the live fold that confirms it is still to be logged.
- **A tool list is part of the prefix.** The note round first shipped with `tools: []`, on the reasoning
  that it forbids tool calls anyway. A Qwen-family template renders the tool list into the system turn —
  the same prompt with and without tools shared 228 bytes — so the note round re-prefilled the entire
  request (~7–11k tokens, 6–9 min at 20 tok/s) right before the fold re-prefilled it again. Sending the
  tools with `tool_choice: 'none'` keeps the rendered prompt byte-identical and forbids the call at the
  sampler instead. Neither re-prefill showed up in the cache trace, because the trace compared messages
  while the tool list lives in the rendering.
- **chars ÷ 4 is not a token count.** It is the usual estimate, and it is close on prose. On SVG path
  data, CSS and code it was 2.5× low — about 1.6 characters per token. One run estimated ~10k prompt
  tokens and sent 25,389 to a 24,576-token window, and the server rejected it. Worse, the correction
  factor learned from earlier prose turns (0.888) had pushed the estimate further down, so compaction
  never fired. The fix splits the two jobs: anything the request adds for the first time is priced at
  the pessimistic 1.6, which makes the size cap a real guarantee, and the compaction decision never
  assumes content sparser than chars ÷ 4.

## A fold should ask for the model's findings before it drops them

The recap a fold leaves is a ledger of what was read, with none of what was found in it: the model's
conclusions live in reasoning, and the fold drops reasoning.

The measurement that motivates the fix came from a subagent A/B. The arm with no delegation had every
file the answer needed by round 6 — then folded five times and re-read them after each fold (one file
was read at round 8), ran 3h01m, and never answered. The delegated arm's subagent was forced to write
its findings at its cap, and the parent answered 7/7 from that digest. Same model, same files; the one
difference was that one path was asked for its findings before they were dropped.

So the parent path now asks: when a fold is due, one extra call returns the model's own short note over
the unfolded history, and the recap leads with it. The note never enters history as an assistant
message — the reasoning that wrote it must not carry over — and it supersedes the previous fold's
narrative, so recaps never stack. The round is gated on the fold actually removing something, since a
fold that keeps everything has nothing to replace. The cost is one generation per fold.

## A small model takes tool output literally

A frontier model reading an odd tool result often notices that it is odd. A Q2 model takes it at its
word and acts on it, so any tool output that _can_ be misread will be, and the loop that follows looks
like a capability problem when it is a wording problem in the harness.

- **"0 matches" meant two different things.** grep answered `Found 0 matches` both when nothing matched
  and when it could not serve the call at all — a glob-style `include="*.css"` against a filter that
  expected a suffix, or a `~/…` path taken literally. The model read both as "the pattern is wrong" and
  spent five rounds rewording a search that should have hit on the first call. The fix was two rules:
  accept the dialect the models actually emit (glob includes, tilde paths), and make a call the tool
  cannot serve say so, distinctly from an empty result.
- **A summary read as "already handled".** Old tool output collapses to its one-line summary, and the
  oldest goes first. `/issue` opens by fetching the issue, so the task definition was the _first_ thing
  dropped, leaving `Ran: gh issue view 213 (505 bytes output)`. The model read that as a result it had
  already dealt with, said it would re-read the issue, made no tool call, and quoted issue text that does
  not exist. The fix pins the turn's opening tool result, and states once per request that earlier
  results were dropped and can be re-run.
- **A cut-off result read as a failed command.** When output is truncated to fit the window, models
  re-ran the same command with different flags, trying to repair a command that had worked. The
  truncation marker now says it is a context limit, not a command error.
- **The model was reading its own tool calls back.** A 35B at Q2 kept re-reading the same file in a loop,
  with its reasoning repeating verbatim. The model was not the cause. It sometimes writes a tool call
  inside its reasoning, and reika recovered the call but fed the reasoning back with the raw
  `<function=read>…` markup still in it — so every round the model read its own call intent and fired
  it again. Stripping the markup ended the loop, and the same model went on to find the real bug and
  edit it. The loop detectors that had been built against that loop stayed on as a net for real ones.

The rule this left behind: before adding an intervention for "the model is stuck", check what the model
is actually being shown. Several of these failures were harness bugs, not capability.

## Prompt wording is the weakest lever, and the one hardest to bound

At Q2, on a vague task, the model converges or spirals about 50/50 — and no amount of intervention code
moves that rate. What the harness can move is what the failing half _costs_: a clean honest stop in
minutes instead of a 30-minute spiral or a committed garbage plan. The levers that move the rate sit
outside the loop: input clarity and plan grounding.

Two measured prompt-level attempts, both instructive:

- The dropped-payload ledger tells the model that an earlier result was dropped and to re-run that call.
  It is a prompt-level bet with a real downside — re-fetching aged results is exactly the loop the
  read-loop ladder exists to catch — so it shipped flagged off, and a single-variable A/B split the way
  the feature predicts: the baseline reconstructed a dropped diff from memory and only then doubted
  itself, the ledger arm re-fetched it. The re-fetch loop never appeared. For that one, transcripts were
  the only instrument that saw anything.
- The subagent nudge ("this looks trace-shaped, delegate it") measured over-eager at round 0 and lost its
  A/B to the compaction note alone, so it stays off. Its mid-session successor is triggered by a harness
  fact instead of a wording, and even then the single live run had the model hear the suggestion, weigh
  it, and decline it for trust — uptake 0/1. It is on for its bounded cost, not for a measured win.

What replaced wording is harness enforcement, on facts the harness can see:

- A written plan is tracked step by step from what happened — a successful edit to a file the step names,
  a step-quoted snippet appearing in an edit's diff, an exit-0 command containing the step's command. The
  model's own claim of progress is never the signal.
- Edits are typechecked against a pre-edit baseline, so only errors the edit _introduced_ come back to the
  model.
- An edit to a file whose bytes are no longer live in context is withheld once, with a directive to read
  the file first — grounding by liveness rather than by "has ever read".

Not every default-on feature was measured: the read-first gate and the subagent pressure footer are on
for a bounded worst case, not a measured win. The read-first one carries its own measurement into the
bounce log (`would-land=yes|no`), which is what will decide whether the default holds.

Two exceptions worth keeping. A natural-language meta-instruction _does_ reach a spiral where a
token-level nudge does not: on a plan-mode spiral, two unsteered attempts — one of them carrying a
`logit_bias` — gave up, and a third with a failure-naming steer ("do not overcomplicate… do not repeat or
question yourself") converged in ~500 reasoning tokens where the others had reached 18k characters.

And one prompt rule measured as a clear win, which shows both where wording works and where it stops.
On two fixtures where a change has to reach the callers of a function, one of them behind an alias, an
API-hosted DeepSeek V4.1 Flash in agent mode passed 4 of 10 runs, and none of the six failures had
opened a single caller. [Grind mode](usage.md), a fixed seven-step procedure prompt, passed 8 of 10,
and its gain traced to one step: review the diff and check the callers. That step alone, added to agent
mode as a rule, passed 10 of 10 and cost nothing on the other fixtures, so it is now on by default. On
a local Qwen3.8 27B the rule changed behavior but not much of the outcome. On the direct-call fixture
it searched for callers in 2 of 3 runs against 0 of 3, and passed 1 of 3 against 0. On the alias
fixture it searched by the literal name, stopped at the alias, and passed 0 of 3 with or without the
rule. A small model follows "find the callers" exactly as far as a name search reaches.

## Reasoning loops separate cleanly from healthy work

The detectors are simple statistics, and what makes them usable is how far apart the two populations sit.

- **Cross-round similarity** (Jaccard over word-level 8-grams, threshold 0.6 for 2+ rounds): healthy
  rounds peak around 0.2–0.3, locked loops sit at 1.00. A 38-round productive agent turn never fired it.
  The 8-gram width is what keeps mechanical work safe — a per-file round that differs only in a filename
  measures ~0.33 against that 0.6 threshold, because every shingle spanning the varying word is
  invalidated.
- **Within-block repetition**, used for the live signal: the ratio curve was re-measured against 84 real
  reasoning blocks and set to 0.35 below ~16k characters, scaling down toward 0.25 as one block grows to
  28k. The earlier 0.75/0.4 pair left a hole that a semantic loop — one that keeps restating the same
  analysis in new words — walked straight through. A separate absolute length ceiling catches a
  low-repetition spiral (~0.3) that no ratio curve can see.
- **Healthy plan-mode blocks measured 0.000–0.063** on the same statistic, against a carry threshold of
  0.15, which is what makes it safe to keep a cut-off plan draft rather than discard it.
- **The gate is the ratio, not which limit fired.** On one run the `max_tokens` wall and the reasoning
  ceiling landed 5.4% apart (30,270 characters against 32,000) — so which one won was nearly arbitrary,
  and the two cannot carry opposite meanings. That block had been cut one clause _after_ solving its
  problem, at a ratio of 0.014, and the old rule discarded it as repetitive and made the model re-fetch
  the same files. It now continues instead.
- **Drift is visible earlier than any threshold.** Alongside the verdicts, the debug log carries
  entropy and KL divergence per round. A spiral reads as `klPrev` collapsing toward zero while `klBase`
  stays high — it drifted somewhere and stopped moving — and that separation shows up rounds before the
  similarity threshold is crossed. Nothing branches on these numbers; they exist to be looked at across
  runs, because they vary by quantization.

## What a feature buys is what the baseline fails to do

The bash spill fixtures (3 runs each on one model) are the clearest example of measuring the baseline
honestly. With the flag on, five of six runs followed the pointer to the saved artifact, and all three
one-shot runs read it as the very next call. With the flag off, the tasks still got answered: one model
recomputed the verdict with `wc -l`, another re-ran its checker more narrowly. So what the feature buys
is a re-execution avoided, not a question that could not be answered — a smaller claim, and the true one.

## What didn't work

- **A coherence anchor.** The idea: weak quants burn capability re-deriving where they are, so pin a
  short state block — the goal plus the last five distinct actions — into every agent request. Benched
  on two real tasks, about three runs per arm, it was null on the easy one and directionally worse on the
  hard one (2 of 3 completed without it, 1 of 3 with it). The state the model loses is fine-grained —
  a helper's signature, which state field, a CSS class — and an action list cannot carry that. It was
  removed rather than tuned, since the problem was granularity, not wording.
- **Removing a tool to forbid it.** Covered above: a report round sent with `tools: []` forbade tool
  calls and silently re-prefilled the whole request, because the template renders the tool list.
  `tool_choice: 'none'` forbids the call without touching the prompt.
- **Routing to a subagent by forecast.** A prompt rule that said "when answering needs more than ~3
  files, delegate" had 0 of 2 uptake: the model never predicts, it takes the obvious next step and
  greps. Keyed on the request's shape it fired, but too eagerly, and lost its A/B to the compaction
  note. It is off.
- **N-gram speculative decoding.** A net loss on the 16GB M2, though it is a real win on hardware with
  more headroom. That is the general warning: a serving optimization measured on a bigger machine has to
  be re-measured on the one you run.
- **Recall tools, not built.** A `history_search`-style tool for reaching dropped context was
  considered and rejected without a bench, on the reasoning that an untrained model under-uses a tool it
  has never seen. Saved tool output is reachable instead through a file path in the result, which the
  model opens with the `read` it already uses constantly — and in the fixtures it did, usually as the
  very next call.

## How these were measured

- **Every default-on feature leaves a baseline arm behind.** `REIKA_*=0` turns the feature off, so the
  same fixture can be run with and without it and the two runs compared.
- **Runs validate their own arms.** Each session logs the flags it ran under, and the report scripts
  refuse to diff arms whose flag lines are identical — that is a variance baseline, not a result — or
  whose build never emitted the feature's debug line, meaning the flag was read by nothing.
- **Multiple runs, always.** A local quantized model is not deterministic, so a single run says very
  little; the fixtures are run three or more times per arm. Some fixtures are kept _because_ they fail,
  for what the failure documents.
- **The instrument has to be able to see the thing.** For some findings the debug log was blind — the
  dropped-payload A/B was only visible in the transcripts — and for others the log is the only place the
  number exists at all: `prefix-cache reprocess=<tok> est=<s> rate=<tok/s>`, `read-trace`,
  `reasoning-loop`, `verbatim-abort … reason=length|ratio … ceil=`, and an `entropy` line per round.
- **Report scripts over impressions.** `evals/prefixcost-report.ts` prices prefill per event;
  `readtrace-report.ts` and the other `*-report.ts` scripts diff two debug logs and print the
  difference.
