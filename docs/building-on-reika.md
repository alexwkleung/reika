# Building on Reika

[← README](../README.md)

This page is for people building their own coding harness who want to borrow from Reika, whether
that means code, design or measurements. It covers the parts that stand on their own, the parts that
only make sense under Reika's own conditions, and the decisions that were measured rather than
assumed. Reika is Apache-2.0, so lifting code is fine as long as you keep the license and
[NOTICE](../NOTICE).

The short version: **individual modules lift out easily, and the agent loop doesn't.** `src/` is
about 41k lines across 144 files, one concept per file, so most subsystems are a file or two with
few local imports. The exception is [`src/agent/loop.ts`](../src/agent/loop.ts) (~4,300 lines), where
context management, loop breaking, the plan gates and the provider latches all meet. Fork the
pieces, not the loop.

## What lifts out whole

These modules depend on nothing model-specific. Each one solves a problem any harness that runs
shell commands, talks to a local engine or draws a terminal UI will run into.

| Module                                                      | What it does                                                                                                                                                                                      | Local imports                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [`tools/_heredoc.ts`](../src/tools/_heredoc.ts)             | A small shell lexer: which `<<` is an operator, where a heredoc body ends, which text is quoted. Reports what it cannot read exactly as uncertain so callers can fail closed                      | none                         |
| [`tools/_carriers.ts`](../src/tools/_carriers.ts)           | A table of command wrappers (`sudo`, `env`, `timeout`, `nice`, …): their value-taking flags, and whether they change what the command means                                                       | none                         |
| [`tools/_readonly.ts`](../src/tools/_readonly.ts)           | Two predicates: "provably read-only" (an allowlist that must under-allow) and "inspection escape" (catches a looping model reading through the shell). Why there are two is explained in the file | `_heredoc`, `_carriers`      |
| [`tools/_danger.ts`](../src/tools/_danger.ts)               | Which bash commands need a human: destructive commands, publishing, package installs at any scope, network verbs in command position                                                              | the three above, `_markdown` |
| [`tools/_sandbox.ts`](../src/tools/_sandbox.ts)             | A macOS Seatbelt profile generator plus a per-command network classifier, with no proxy layer                                                                                                     | `_heredoc`, `_readonly`      |
| [`tools/_treediff.ts`](../src/tools/_treediff.ts)           | Diffs for files a shell command changed, with git as the change detector instead of parsing the command                                                                                           | `_diff`, `_writetargets`     |
| [`tools/_spill.ts`](../src/tools/_spill.ts)                 | Writes a capped tool result in full to a session temp file, and gives the model a short path it can page with `read`                                                                              | none                         |
| [`tools/_hosts.ts`](../src/tools/_hosts.ts)                 | A private-address guard that runs at connect time, which closes DNS rebinding                                                                                                                     | `provider/dispatcher`        |
| [`mcp/`](../src/mcp/)                                       | A stdio MCP client that speaks both the pre- and post-`2026-07-28` protocol, plus a bridge that narrows server schemas to what providers accept                                                   | `debug`, `version` (client)  |
| [`provider/latches.ts`](../src/provider/latches.ts)         | Per-endpoint degrade latches, so one strict server's quirks don't follow you to the next                                                                                                          | none                         |
| [`provider/dispatcher.ts`](../src/provider/dispatcher.ts)   | Lifts undici's 300s timeouts, which kill a turn mid-prefill, without adding a dependency                                                                                                          | `debug`                      |
| [`agent/prefixtrace.ts`](../src/agent/prefixtrace.ts)       | Classifies why each request diverged from the previous one: append-only, trailing note, mid-history rewrite, tool list changed                                                                    | none                         |
| [`agent/reasoningtrace.ts`](../src/agent/reasoningtrace.ts) | Detects rumination from 8-gram similarity across rounds and within one block                                                                                                                      | none                         |
| [`ui/syncframe.ts`](../src/ui/syncframe.ts)                 | Coalesces Ink's writes into one DEC 2026 synchronized frame, which stops flicker under memory pressure                                                                                            | `framedrops`                 |
| [`search/_chrome.ts`](../src/search/_chrome.ts)             | A dependency-free CDP client and browser host: discovery, a hidden launch, reattach                                                                                                               | `debug`, `search/types`      |

Each module has a colocated `*.test.ts`. For the permission-boundary files (`_readonly`, `_danger`,
`_sandbox`) the tests are worth taking as well, since they enumerate the bypasses that were found.

## What lifts out as a design, not as code

These ideas are model-agnostic, but in Reika they're woven through the loop, so it's easier to
reimplement them than to extract them.

- **Requests stay append-only between shrink events.** Payloads stay live with frozen rendered
  bytes until the prompt crosses a threshold, then age in one batch. On a local engine, every
  mid-history rewrite re-processes the prompt from that byte onward, and hybrid/SWA models re-process
  all of it. One measured mid-context edit on a 27B cost 7.9 minutes, against 3.5 seconds for an
  append. Hosted prompt caching rewards the same discipline.
- **Ask for findings before a fold drops them.** Right before compaction, one extra tool-less round
  asks the model to write down what it has established, and the recap leads with that note. A recap
  that is only a ledger of reads loses everything the model concluded from them.
  See [Findings](findings.md#a-fold-should-ask-for-the-models-findings-before-it-drops-them).
- **Pin the opening tool result.** `/issue`-style flows fetch the task definition first, and
  oldest-first aging drops it first. After that, the model sees only a summary that reads like a
  result it already handled.
- **Make a dropped payload loud.** An aged result that serializes to its summary alone reads as
  "seen and handled", not as "gone". One ledger line per request says which results are gone and
  how to get them back.
- **Escalate loop breaking in stages: redirect, ledger, withdrawal, honest stop.** Withdrawal has to
  be enforced where calls are dispatched, not where tools are offered, because a model that calls
  tools in text routes around a tool that is merely missing from the list.

## What is tuning, and may not transfer

Every number below was fit to 8–35B models at Q2–Q4, on 16–32k windows, from a handful of model
families. Treat them as starting points to re-measure, not as constants.

- **Detector thresholds**: crossSim 0.6 over a 2-round streak, the verbatim-abort curve (0.35 down
  to 0.25 between 16k and 28k chars), file overlap depth 4, the 0.7 aging watermark.
- **Compensations for weak models**: the read-first edit gate, plan grounding, the plan done-gate,
  the converge steer and logit recovery. On a frontier model most of these rarely fire. They cost
  little when idle, but they're a lot of code to carry for a model that doesn't need them.
- **Engine-specific pieces**: logit recovery needs llama.cpp's `/tokenize`, and the note-slot probe
  reads llama.cpp's own prompt-token counts.

The thing that does transfer is the method: put each intervention behind a flag with a baseline arm,
log the mechanism under a debug flag, and judge it over 3+ runs, because byte-identical inputs to a
Q2 model have produced 52, 16 and 6 tool calls.

## Decisions measured, not assumed

Each of these cost a debugging session to learn. They apply to any harness, whatever its model.

- **Forbid tool calls with `tool_choice: 'none'`, not `tools: []`.** Chat templates render the tool
  list into the system turn (Qwen's puts it _before_ the system prompt), so dropping the tools
  re-prefills the whole request.
- **Don't send a model's reasoning back in the user role.** LFM2.5 and Qwen3.6 templates drop every
  `<think>` that comes before the newest user message. A harness note sent as a user message
  therefore hides all of the model's earlier reasoning from it, and the model re-derives it. Send
  `chat_template_kwargs: {preserve_thinking: true}` where the template supports it, and attach the
  note to the newest tool result where it doesn't.
- **A note meant to carry authority goes in a user message, not a tool result**, for one-shot
  instructions such as a user's reason for declining. Inside a tool result, a small model read the
  reason as the environment refusing, and retried.
- **Search Brave, not Google or Bing, when driving a browser.** On live results pages, Google and
  Bing launder every outbound link through a tracker (0 of 53 and 0 of 46 usable). Brave returns real
  links and runs its own index.
- **Don't rely on a fresh headless browser profile.** That's the shape search engines CAPTCHA. A
  persistent profile is the anti-bot mechanism, and a bot check is something a human solves once.
- **Gate the network-denial footer on the output, not the command name.** Gating on names fired on
  every red `npm test` and taught the model to blame the sandbox for real failures.
- **Undici's default 300s timeouts abort long prefills.** A prefilling server sends zero bytes, which
  looks exactly like a hang.

The full record, with the A/B arms behind each default, is in [`AGENTS.md`](../AGENTS.md) and
[Findings](findings.md).
