# Changelog

User-facing changes in each release: fixes, changed behavior or defaults, new or renamed config
keys, commands and tools. Reika is 0.x, so a minor version may change behavior and config.

## [Unreleased]

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

- An empty `REIKA_*` line in a project `.env` (`REIKA_SUBAGENT_MODEL=`, as older copies of
  `.env.example` had) no longer hides the value set for that key in `~/.config/reika/.env`, and no
  longer triggers the "Ignored … from ./.env" startup notice.

### Security

- The sandbox refuses writes to git's `config` and `hooks`, and to the files that decide which
  config git reads (anything named `.git`, `commondir`, `gitdir`), wherever they are — matched by
  name, so renaming or repointing `.git` does not get around it. Both name programs something else runs: `core.fsmonitor` was run
  by Reika's own unsandboxed `git status` after every shell command, and a hook is run by your next
  commit. Reika's own git calls now pass `-c core.fsmonitor=false` and `-c core.hooksPath=/dev/null`,
  switch off any filter driver the repo's own config defines, and skip submodules, so a repo's
  config or hooks cannot make it run a program either way; drivers from your global config, such as
  Git LFS, still apply to the diffs it draws, but LFS never downloads a missing object for one
  (#706). Deleting a nested repo still works; the project's own `.git` cannot be deleted or renamed. The `write`/`edit` tools can still write those paths; that gap is #719.
- The cost, and it is wider than a refused `git config`: `git init`, `git clone`,
  `git submodule add` and `git worktree add` write these paths, so creating a repository — in any
  directory, temp included — is now a command you run instead of the model, and a test suite that
  creates repos in a temp dir fails when the model runs it. Everything else in `.git` — `add`, `commit`, `checkout`, `stash`, `fetch`, the index
  lock — is unchanged.

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
