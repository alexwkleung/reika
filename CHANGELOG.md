# Changelog

User-facing changes in each release: fixes, changed behavior or defaults, new or renamed config
keys, commands and tools. Reika is 0.x, so a minor version may change behavior and config.

## [Unreleased]

### Added

- The approval prompt has a fourth row, **Decline, and say what to do instead**. It opens the input box
  for a reason, and the model gets that reason as a message from you instead of a bare "declined by
  user", which small models often answer by trying the same call again.

### Fixed

- Web search through Chrome no longer reports a result's date ("May 8, 2026", "3 days ago") as its
  title. Brave puts the date last on some results, and the extractor took the last line.
- Web search through Chrome on macOS no longer pulls focus to the search browser. Its launch and
  every search's tab used to activate it. A bot check still brings its window to the front.
- The Chrome search browser on macOS quits from the Dock again. The focus fix above had launched it
  in a mode where Chrome ignores Quit; it now launches hidden instead, which keeps focus just as well.
- The input box no longer jumps up when a long-running command finishes. Its live output now shows
  the same last 10 lines the finished result does, instead of growing to fill the screen and then
  shrinking back.
- The gate's generic install fallback no longer prints an Install command dialog for a read or for a
  filename. `LANG=C grep -rn install src` is a grep, and the test that skips reads like it ran on the
  raw segment, so it saw the assignment and not the `grep` behind it, and grep's own argument read as
  a verb. `cp -r "build install" dist` is a copy, and the whitespace reading kept for an unterminated
  quote ran on every segment, so it cut that quoted argument at a space inside it and found a verb
  there too. The lead is now tested after the verb-prefix strip, which also brings a deep verb back
  into reach (`env A=1 sudo time conda install numpy` and `cat=1 make install` prompt where they did
  not), and the whitespace reading answers only where a quote really was dropped, so the unterminated
  `make CFLAGS="-O2 install` still prompts. What that gives up is an install carried inside a CLOSED
  quoted value — `A="make install" bash -c "$A"` is one expansion from running — and telling it from
  the false positive means expanding it, which is the shell's job and not the gate's (#757).

### Contributors

- @xiaoyu607: Simplified Chinese translations of the pre-install pages and the localized docs site (#700)
- @zlc-131: Simplified Chinese translation of the support page (#784)

## [0.5.0] - 2026-10-19

### Changed

- `REIKA_DEBUG=1` now writes one log per session to `~/.config/reika/logs/`, named after the
  session's auto-save, instead of overwriting `~/reika-debug.log` at each launch, so the log of a
  session nobody planned to debug is still there afterwards. `logs/latest.log` points at the current
  one. Logs are kept for 14 days or 50MB, whichever comes first. `REIKA_DEBUG_FILE` still names one
  file that accumulates across runs.
- `REIKA_BASE_URL` now defaults to `http://localhost:9931/v1`, following llama-server's new default
  port in llama.cpp v0.7.0. A llama-server older than that, or one in llama.cpp's Docker images,
  still listens on 8080: set `REIKA_BASE_URL=http://localhost:8080/v1` for it. A refused connection
  at the default now says so instead of a bare `fetch failed`.

### Fixed

- Commands run in shell mode now reach the model, as the docs said they did: the next prompt carries
  each command, its exit status and the end of its output, sized to the context window (about 1KB a
  run on 16k, up to 4KB), with cut output saved to a file the model can read. They were shown in the
  scrollback only, so asking about a failed run sent the model to run it again.
- A reply that opens by copying reika's continuation marker
  (`[reika: N chars of your earlier reasoning trimmed …]`), or a made-up `[tool result …]` stub in
  the same voice, no longer shows those lines as the answer in scrollback or `/save`. Only lines at
  the head of the reply are dropped, and the model's own history is unchanged (#745).
- A heredoc body the shell only pastes is no longer read as commands by the approval gate's
  verb-position scan, so `python3 - <<'EOF'` with `print("x; curl y")` inside the script no longer
  prompts as a network request — nor does a `node` script, a heredoc written to a file, or prose in
  a commit message. Those labels were an accident of the quote mask: each cost a dialog
  recommending a command nobody was asking to run, and, once approved, ran the command outside the
  sandbox. A body the shell still expands (`<<EOF`, `<<\EOF`) or hands to a shell as its program
  (`bash -s <<'EOF'`, `cat <<'EOF' | sh`) is unchanged, as is the half of the scan that matches the
  whole command rather than each segment, so an `rm -rf` written into a script still prompts (#699).
  Three edges hold the same line: `cat <<'EOF';` does not re-read the body's first line as a
  command, the terminator of an empty body (`cat <<'curl'` / `curl`) is not a command either, and a
  shell reader spelled so the name lookup cannot see it (`cat <<'EOF' | $SHELL`, `| s\h`) keeps its
  body in the scan instead of hiding it.
- The gate's generic install fallback had the same blind spot one function over, and it is gone the
  same way: `python3 - <<'EOF'` with `print("x; make install")` inside the script no longer prompts
  as an install command — a dialog for a script that runs no shell, and an unsandboxed run once
  approved. Both per-segment readers now split a command in one place, on the separators the shell
  itself reads: a separator inside quotes no longer cuts a command short, so
  `FOO="a;b" make install` and `make CFLAGS="-DFOO(x)=x" install` prompt as installs; a
  `\`-continued line is one command; a `$(…)` or backtick inside single quotes
  (`grep -n '$(make install)'`) is text, while one inside double quotes is still read as the
  command it runs. A body a shell actually runs
  (`bash <<'EOF'` with `make install` in it) still reports, and so does a real install the old
  split missed because it sat on its own line of a multi-line command (#749).
- Those same two readers mis-read a quoted word, which hid the verb the other way: under the default
  `safe` mode, `make CFLAGS="-O2 -g -Wall" install`, `FOO="a b" curl https://example.com` and
  `FOO='a b' pkill node` ran with no prompt at all. The space inside the value was a word boundary,
  so the install fell past the three leading words the generic fallback counts and the command after
  the assignment fell out of the anchored verbs' reach. Each reader now also reads the shell's own
  words, where a quoted value is one token whatever it holds — `make DESTDIR="/tmp/a b" install`
  prompts, and so does `make "install"`, because quoting a target does not stop it installing.
  A value the shell builds from pieces (`FOO=pre"a b"`, `$'a b'`, `a\ b`) is one word too, and the
  `VAR=value` operands of a make line no longer count against the verb's position. The
  whitespace reading stays beside it rather than being replaced: an unterminated quote splits its run
  and can push the verb past that budget, and the fragment a blind strip leaves behind is where a
  command one expansion away is still visible (`A="x pkill node" bash -c "$A"`), so quoting can add a
  label and never cost one. Replayed against `main` over the saved session history: no label moved
  in either direction, because none of its 7,723 distinct calls puts a verb behind a quoted value —
  the eleven that come closest carry it inside a heredoc body the shell only pastes (#752).

### Security

- Plan mode's read-only `bash` and the sandbox's network allow for `git`/`gh` now read a command's
  arguments with the shell's own quoting rules — backslash escapes, escaped quotes and `$'…'` —
  where before a flag spelled through them could go unrecognized by the allowlist. Replayed over the
  saved session history (7,745 distinct commands), no decision changed.

## [0.4.0] - 2026-10-15

### Changed

- The process is named `reika` rather than `node`, so a session is identifiable in `ps`, `top` and
  Activity Monitor, and `pgrep reika`/`pkill reika` find it.
- `reika -p` takes `--profile <name>`, so a headless run can use a profile the TUI would resume
  without exporting `REIKA_MODEL` first. The named profile wins over a `REIKA_MODEL` given at launch
  and over the model a mode lists in `REIKA_MODE_MODELS`, because it is the user naming it outright;
  names match case-insensitively, and a name no profile defines prints a notice listing the defined
  ones and runs on the profile the flag would not have changed (#710). `--profile` without `-p` is
  an error, since the TUI does not read it.
- A headless turn that fails names the profile and the base URL it was using, instead of only the
  throw's own message: `reika: turn failed (profile "<name>" at <baseURL>): <error>`, where a route
  that could not be reached used to print `reika: fetch failed` and nothing more (#710).
- `/review` may read one more issue when the linked issue does not state the requirement itself —
  its body only points elsewhere ("see #179", "follow-up to #185") or is too short to say what is
  wanted. It fetches that one issue's title and body once and goes no further; before, it was told
  never to follow an issue's references, so a pointer-only issue left the review without its
  requirement.

### Security

- The post-edit typecheck gate runs its `tsc --noEmit` through the sandbox wrapper, so the project's
  own `node_modules/.bin/tsc` runs under the same confinement as a model-run shell command instead
  of outside it. The binary sits in the directory a sandboxed command may write, so a sandboxed
  command could have replaced it before the harness ran it; it no longer can. When the sandbox is
  unavailable, or switched off with `REIKA_SANDBOX=0`, the gate spawns tsc directly as before. A
  wrapper that refuses at spawn time, or a tsc the shell cannot execute, is detected rather than read
  as a clean check, and turns the gate off for that turn instead of retrying unsandboxed: the refusal
  is read from tsc's own output, so a planted binary could otherwise fake one to get the unconfined
  run (#708).
- A shell command can no longer fake a sandbox failure to get itself re-run unsandboxed. A sandbox
  profile that fails to load was detected from the command's own output and retried with no
  confinement, so `echo 'sandbox-exec: x' >&2; exit 65`, or any script shaped like it, got a second
  run that could write outside the project and reach the network. The profile is now checked once
  per project before any command runs, and a command is never re-run; a profile that really fails to
  load still runs commands unsandboxed, with the same warning (#738).

## [0.3.0] - 2026-10-12

### Changed

- Default `REIKA_MAX_TURNS` raised from 200 to 400 and `REIKA_SUBAGENT_MAX_TURNS` from 8 to 10.
  The loop detectors stop a stuck turn; the turn cap is only a backstop for what they miss, and
  200 could end a healthy long turn on a fast endpoint. Headless runs, where the cap is the only
  stop, can run up to twice as long before it fires. A `.env` copied from an earlier
  `.env.example` still pins the subagent value at 8.
- `.env.example` leaves every optional key commented out. Copied into a project `.env`, its empty
  lines hid the same keys set in `~/.config/reika/.env` and triggered the "Ignored … from ./.env"
  startup notice.

### Fixed

- The "No context window known" warning for a hosted model now says why: models.dev had no entry
  for the profile's base URL (or listed the URL but not the model), which other base URLs it lists
  on the same host, and which profile keys to set (`REIKA_<NAME>_BASE_URL`,
  `REIKA_<NAME>_CONTEXT_WINDOW`). When a provider moved its URL on models.dev, the old warning
  pointed at a local-server setting instead.
- An empty `REIKA_*` line in a project `.env` (`REIKA_SUBAGENT_MODEL=`, as older copies of
  `.env.example` had) no longer hides the value set for that key in `~/.config/reika/.env`, and no
  longer triggers the "Ignored … from ./.env" startup notice.
- A sandbox write-denial is read from the shape a tool prints it in — the shell's
  `/bin/sh: /path: Operation not permitted`, or git's path with no program name in front — not from
  the phrase "Operation not permitted" appearing anywhere in the output. Reading a diff, a log or a
  test fixture that only quotes the error no longer tells you the sandbox refused a write that never
  happened, or offers to turn the sandbox off over it. Text quoting node's or python's mid-line
  shapes can still read as a denial. A denial behind a task runner's line prefix (turbo, `pnpm -r`)
  or indentation is still reported. The refusal lines also stopped saying "outside the working
  directory", which was wrong for a refused `.git/config` or hook (#720).
- A sandbox write-denial is also read from the shapes the #706 refusals print: a path with no
  slash after one of the file verbs (`rm -rf .git` prints `rm: .git: Operation not permitted`, and
  `mv .git .g` prints `mv: rename .git to .g: …`); only those verbs may introduce a slashless
  path, so `docker: connect: operation not permitted` still reads as the network denial it is, and
  git's quoted form `fatal: cannot copy '…' to '…': Operation not permitted` (what `git init`
  prints). Once a run passes the 64KB output cap, the 4KB tail the command chip shows is scanned
  too, so a refusal printed after a long build log is no longer invisible, and a `ps` refusal no
  longer hides a refused write in the same output (`ps aux | grep node; mkdir ~/x` reports both)
  (#723).
- The write-denial check no longer fires on a refusal that is only being quoted behind a colon column
  of its own: `Expected: rm: .git: Operation not permitted` (a failing test's assertion header over
  the value it compared), `+ mkdir: /path: Operation not permitted` (a diff's added or removed line,
  as `gh pr diff` prints one), `AssertionError: /bin/sh: /path: Operation not permitted` (Reika's own
  sandbox tests under a `grep -E "AssertionError|expected"`), at line start or behind a runner's own
  column (`web:build: Expected: …`), or behind a bare `Error: ` header. A runner's own column still counts —
  turbo's `web:build: `, pnpm -r's `packages/web build: `, a `[0] ` job number, concurrently's
  `name | `, indentation, and a go error chain — so a denial behind one is still reported; any other
  column shape now costs a footer rather than producing one for a write that never happened (#726).

### Security

- The sandbox refuses writes to git's `config` and `hooks`, and to the files that decide which
  config git reads (anything named `.git`, `commondir`, `gitdir`), wherever they are — matched by
  name, so renaming or repointing `.git` does not get around it. Both name programs something else runs: `core.fsmonitor` was run
  by Reika's own unsandboxed `git status` after every shell command, and a hook is run by your next
  commit. Reika's own git calls now pass `-c core.fsmonitor=false` and `-c core.hooksPath=/dev/null`,
  switch off any filter driver the repo's own config defines, and skip submodules, so a repo's
  config or hooks cannot make it run a program either way; drivers from your global config, such as
  Git LFS, still apply to the diffs it draws, but LFS never downloads a missing object for one
  (#706). Deleting a nested repo still works; the project's own `.git` cannot be deleted or renamed. The `write`/`edit` tools now gate the same paths through the approval dialog instead of landing silently (below).
- The cost, and it is wider than a refused `git config`: `git init`, `git clone`,
  `git submodule add` and `git worktree add` write these paths, so creating a repository — in any
  directory, temp included — is now a command you run instead of the model, and a test suite that
  creates repos in a temp dir fails when the model runs it. Everything else in `.git` — `add`, `commit`, `checkout`, `stash`, `fetch`, the index
  lock — is unchanged.
- The `write`/`edit` tools gate the same paths the sandbox refuses for shell commands: writing to a
  repo's `config` or `hooks` (or to the files that decide which config git reads) raises the same
  warning in the approval dialog an out-of-project write does, so under `safe` it cannot be
  auto-approved silently — an approved write still lands, and with approvals bypassed it is refused
  outright. Writing a hook or a `core.fsmonitor` through a file tool now needs the same deliberate
  user approval a sandboxed command would have, instead of landing with nothing to clear (#719).

## [0.2.0] - 2026-10-10

### Security

- A `.env` in the working directory can no longer change sandbox, approval, endpoint, API key or
  MCP settings, or set non-Reika environment variables. Only `REIKA_*` keys are read from it, and
  Reika warns at startup about any security-relevant key it ignored. Set those in your shell or
  `~/.config/reika/.env`.

## [0.1.2] - 2026-10-09

### Fixed

- Ctrl-C in the `ask_user` dialog's free-text answer field returns to the options instead of
  aborting the turn, and backing out discards what was typed there rather than leaving it in the
  prompt box to be sent by a stray Enter (#651).
- The sandbox and the dangerous-command scan read shell quoting and heredocs with a lexer that
  follows `/bin/sh`, closing cases where an escaped quote, a `$'…'` string or an unusual heredoc
  delimiter hid a second command from the approval prompt or the network rule (#685, #695).
- Git's global options are read fail-closed, and subcommand options that run a program
  (`--upload-pack`, `clone --template`/`-c`, `rebase -x`, …) no longer keep the sandbox's network
  allow. A subcommand's own `-c` (`git grep -c`, `git log -c`) no longer costs the call its network
  (#684).

### Changed

- The slash-command menu shows a down arrow when it has more entries than fit.

## [0.1.1] - 2026-10-06

### Fixed

- The user message bubble wraps by terminal cells rather than code units, so prompts with CJK,
  emoji or other wide characters no longer overflow or misalign (#689).
- `/help` lists `/plan`, `/approvals` and `/skills`.

## [0.1.0] - 2026-10-04

First public release, on npm as `@alexwkleung/reika` and on Homebrew as `alexwkleung/tap/reika`.
