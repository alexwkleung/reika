# Changelog

User-facing changes in each release: fixes, changed behavior or defaults, new or renamed config
keys, commands and tools. Reika is 0.x, so a minor version may change behavior and config.

## [0.1.1] - 2026-10-06

### Fixed

- The user message bubble wraps by terminal cells rather than code units, so prompts with CJK,
  emoji or other wide characters no longer overflow or misalign (#689).
- `/help` lists `/plan`, `/approvals` and `/skills`.

## [0.1.0] - 2026-10-04

First public release, on npm as `@alexwkleung/reika` and on Homebrew as `alexwkleung/tap/reika`.
