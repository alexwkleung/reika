# Instructions and skills

[← README](../README.md)

## Instructions (`AGENTS.md`)

Standing guidance for the model, loaded into the system prompt once at startup:

- Global: `~/.config/reika/AGENTS.md` — your personal preferences, applied in every project.
- Project: `<cwd>/AGENTS.md` — the repo's conventions.

When both exist they are merged, global first, with the project file stated as winning where they disagree — so a personal "terse replies, no emoji" rides along without displacing the repo's build/test rules. `CLAUDE.md` is accepted as a fallback name in either location. Each file is capped at 12KB (≈3k tokens); over that it is replaced by its heading outline plus a pointer to read the relevant section, so an oversized file never crowds a small context window.

## Skills (reusable prompt templates)

Drop a `*.md` file in a skills directory and it becomes a slash command. Useful for saved workflows (`/review`, `/deploy`, `/refactor`, etc.).

**Locations (project shadows global on name collision):**

- Global: `$REIKA_SKILLS_DIR` if set, otherwise `~/.config/reika/skills/`
- Project: `<cwd>/.reika/skills/`

**Skills Reika ships with:**

Two live in this repo, under `.reika/skills/`, so they load automatically when you run Reika on Reika — and so the workflows Reika's own development leans on are readable and reviewable rather than living only in someone's home directory:

| Skill     | What it does                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------- |
| `/issue`  | Reads a GitHub issue with `gh` (title + comments, since bodies are often empty), then works on it |
| `/review` | Reads a PR and its linked issue with `gh`, pages the diff, and reviews it in the terminal         |

They are project skills, so they only apply inside this checkout. To get them in every project:

```sh
npm run skills:link              # symlinks each into ~/.config/reika/skills/ (or $REIKA_SKILLS_DIR)
npm run skills:link -- --force   # also replace same-named files already there
```

Symlinks, not copies — `git pull` then updates them everywhere. Optional: nothing else in Reika depends on it, and a same-named skill of your own in the global dir is left alone unless you pass `--force`.

**Layouts (both supported):**

- **Flat file:** `~/.config/reika/skills/review.md` → `/review`
- **Directory with `SKILL.md`:** `~/.config/reika/skills/review/SKILL.md` → `/review`. Lets a skill carry supporting files (scripts, reference docs) — only `SKILL.md` is used as the prompt body; other files are ignored. Matches the Claude Code skill packaging convention, so you can drop skill folders in verbatim.

**File format** — plain markdown with optional YAML frontmatter. Example below:

```md
---
description: Review the current branch end-to-end
triggers: review the branch, code review, look over my changes
---

Review the changes on this branch:

1. Run git diff main...HEAD
2. Check for missing tests on changed code
3. Check for inconsistencies with AGENTS.md
   Report a punch list.
```

Without frontmatter, the first non-empty line becomes the autocomplete description; the whole file is the prompt body.

**Invocation:**

- `/review` — sends the file body as your input
- `/review focus on the API changes` — appends extra args to the body, separated by a blank line
- `/skills` — list available skills

### Plain-English routing (`triggers`)

You don't have to remember the slash command. `triggers:` lists phrases that route an ordinary prompt to the skill — matched **deterministically in the harness**, never by the model. Writing "review the branch for me" gets you a one-line hint that `/review` exists and that the prompt was sent unchanged; the turn runs normally either way.

The frontmatter accepts any YAML list shape (`triggers: a, b`, `triggers: [a, b]`, or a `- ` block list). The skill's own name is always an implicit trigger, so a skill called `verify` routes "verify my changes" with no `triggers:` at all.

Matching rules, in short:

- Whole-word only — a skill named `test` does not fire on "latest"
- Multi-word phrases score higher than single words; phrases under 3 characters are ignored
- A tie between two skills suggests neither (routing by array order would be arbitrary)
- Continuations (`yes`, `ok`, `continue`, `do it`, …) never route
- A skill is suggested at most once per session — decline it once and it stops asking

**Confirm-to-apply (`REIKA_SKILL_AUTO`, default `ask`):** on a strong match a two-row dialog opens over the input before anything is sent — `1. Send as typed` (selected) and `2. Apply /review` — with the prompt still in the box underneath. ↑↓, the digits and `y`/`n` move the cursor (`y` lands on Apply), Enter answers, ctrl-c drops the submit and leaves the prompt to edit. Applying prepends the skill body to your prompt with a scrollback receipt naming which phrases matched; declining sends it as typed with no hint line. Strong means the prompt has the shape of a command, not just its keywords — two distinct triggers or one multi-word phrase, and a matched phrase opening the prompt (a `please` / `can you` lead is fine) — so `review pr 420 but first explain how the recap is built` asks while `there is an issue with the pr review flow` only suggests. Refused when the body would take more than ~15% of the context window, and never in chat mode, which has no `bash` for a skill's first step; plan mode asks like the others, and its own prompt keeps an applied body to planning. A prompt submitted while a turn is running is asked about right then, and the queued entry carries your answer to the replay. It is on by default because a wrong pick now costs one keystroke rather than a turn. Headless runs have nobody to ask, so `ask` sends the prompt as typed there; `REIKA_SKILL_AUTO=apply` (or `1`) lets `-p` apply a strong match without asking — and only when the prompt is 12 words or fewer, the cap that prices a wrong pick with no one to catch it. The TUI still asks under `apply`: a human present is never a reason to inject silently. `off` leaves only the hint line.

### Pasted URLs

Paste an `http(s)` link into a prompt and Reika fetches it before the turn starts, prepending the extracted content as a `<url href="…">` block — the same mechanism as `@file` mentions, so the model reads the page instead of guessing at it. Up to 2 URLs per prompt, truncated to 8k characters each (`fetch_url` gets the rest). Every fetch leaves a scrollback line, and a dead link is reported as one rather than silently dropped. Set `REIKA_PASTE_FETCH=0` to turn it off — worth doing on an airgapped machine.

Only URLs _you_ type are fetched. Links inside an `@`-mentioned file are file content, and links the model writes are handled separately by URL grounding (`REIKA_URL_GROUNDING`).

**Rules:**

- Built-in commands always win over skills with the same name — you can't shadow `/help` or `/exit`
- Skill names are lowercased filenames; only `[a-z0-9_-]` are accepted (skip files with weird names)
- Skills load at bootstrap and on `/cd` — edit a file mid-session, then `/cd .` to refresh
- Files under `<cwd>/.reika/` (including `.reika/skills/`, `.reika/handoff/`, etc.) appear in `@` autocomplete — handy for inlining a project-local handoff doc, an in-repo skill file, or any other Reika-scratch content. Other dot-dirs (`.git/`, `.vscode/`, etc.) stay hidden.
