# Changelog

User-facing changes in each release: fixes, changed behavior or defaults, new or renamed config
keys, commands and tools. Reika is 0.x, so a minor version may change behavior and config.

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
