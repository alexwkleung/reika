---
name: verify
description: Build/launch/drive recipe for verifying reika (Ink TUI) changes end-to-end against a mock OpenAI-compatible SSE server.
---

# Verifying reika end-to-end

reika is an Ink TUI — it needs a real pty. `script(1)` fails with "Raw mode is not
supported"; use `expect`. No build step needed for verification: run straight from source
with tsx.

## Launch

```sh
# From ANY cwd (point cwd at a small temp project so bootstrap is instant).
# --tsconfig is REQUIRED when cwd is outside the repo: tsx resolves tsconfig from cwd,
# and without it JSX compiles classic → "ReferenceError: React is not defined".
node /path/to/reika/node_modules/.bin/tsx \
  --tsconfig /path/to/reika/tsconfig.json /path/to/reika/src/cli.tsx
```

Env for a hermetic run: `REIKA_MODEL=test REIKA_BASE_URL=http://127.0.0.1:<port>/v1
REIKA_DEBUG=1 REIKA_DEBUG_FILE=<scratch>/debug.log` (+ whatever flag is under test).
Debug output MUST go to the file, never stderr (corrupts the Ink frame). Note shell env
overrides `.env`; a global `~/.config/reika/.env` may still supply e.g. REIKA_CONTEXT_WINDOW.

## Mock server

A ~60-line node http server on `/v1/chat/completions` returning SSE
(`data: {choices:[{delta:...}]}`, a usage frame with `prompt_tokens_details.cached_tokens`,
then `data: [DONE]`) is enough for full turns. Log one JSON line per request
(max_tokens, roles, last content) — that log is the primary evidence. Gotchas:

- Detect client aborts with `res.on('close')` + `!res.writableEnded`; `req.on('close')`
  fires on request-body completion in modern Node, not on disconnect.
- Delay the stream ~400ms so in-flight cancellation paths are observable.

## Driving with expect

- `set send_slow {1 .12}` and `send -s` — coalesced chunks read as paste and eat the `\r`.
- Wait for the footer text `"attach files"` before the first keystroke (bootstrap gate),
  then drain a few seconds more.
- expect only reads pty output during `expect` commands. Between every send, wait with a
  timed never-match drain: `expect -timeout 2 -re "ZZZ_NEVER_MATCH_ZZZ" {} timeout {}` —
  it reads continuously for the full window. `expect -timeout 1 -re {.+}` returns
  instantly on buffered frames (no wall time passes), and bare `sleep` reads nothing;
  either way pty backpressure blocks the app and the next send coalesces into a paste
  chunk whose `\r` becomes an inserted newline instead of a submit.
- Ctrl+C with a non-empty input clears the input; twice while empty arms+confirms exit.
- Pane evidence: `log_file`, then strip ANSI with
  `perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/\r/\n/g'`.
- Match phrases must be unique to the target output — the status bar ("shift+tab") and
  suggestion descriptions sit in every frame; `Commands:` is a good /help marker.
- When input lands wrong, don't theorize: temporarily `debugLog` `(input, key.return,
value)` at the top of Input's `useInput` to see how each chunk was parsed.

## Flows worth driving

Type-a-prompt → submit → assistant reply renders and status returns idle; slash command;
Ctrl+C mid-turn abort. Status bar shows ctx/cache gauges — cache % is fed by
`cached_tokens` from the mock.
