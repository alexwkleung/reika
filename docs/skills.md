# Instructions and skills

[← README](../README.md)

## Instructions (`AGENTS.md`)

Standing guidance for the model, loaded into the system prompt once at startup:

- Global: `~/.config/reika/AGENTS.md` — your personal preferences, applied in every project.
- Project: `<cwd>/AGENTS.md` — the repo's conventions.

When both exist they are merged, global first, and the project file is named as the one that wins
where they disagree. A personal "terse replies, no emoji" comes along without displacing the repo's
build and test rules. `AGENT.md` and then `CLAUDE.md` are accepted as fallback names in either location; only
the first one found is loaded.

Each file is capped at 12KB (≈3k tokens). An oversized file is replaced by its heading outline plus a
pointer to read the relevant section, so it can't crowd out a small context window.

## Skills (reusable prompt templates)

A `*.md` file dropped in a skills directory becomes a slash command, which is useful for saved
workflows (`/review`, `/deploy`, `/refactor`). When two share a name, project wins over global, and
global over bundled:

- **Bundled:** the skills that ship with Reika (below)
- **Global:** `$REIKA_SKILLS_DIR` if set, otherwise `~/.config/reika/skills/`
- **Project:** `<cwd>/.reika/skills/`

Skills kept for other coding agents load too, from where they already are:

- **Global:** `~/.agents/skills/`
- **Project:** `<cwd>/.agents/skills/` and `<cwd>/.claude/skills/`

Reika's own directories win over these on a name collision; among these, project wins over global
and `.agents` over `.claude`. `/skills` labels each one with the directory it came from. Reika does
not read `~/.claude/skills/`. To use skills kept there, link them in once:

```sh
ln -s ~/.claude/skills ~/.agents/skills
```

### Skills Reika ships with

| Skill     | What it does                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------- |
| `/issue`  | Reads a GitHub issue with `gh` (title + comments, since bodies are often empty), then works on it |
| `/review` | Reads a PR and its linked issue with `gh`, pages the diff, and reviews it in the terminal         |

They only appear where they can work: `gh` must be on your `PATH`, and the current repo must have a
`github.com` remote. Otherwise they are left out of the command list and never offered by plain-English
routing. Reika only checks that `gh` exists and does not run it at startup, so a `gh` that is installed
but logged out still shows the skills, and the first call says what is wrong.

To change one, copy it into your global or project skills directory under the same name; your copy
replaces the bundled one. A skill of your own can declare the same requirements with a `requires:`
frontmatter line (`requires: gh, github`). A requirement Reika does not recognize hides the skill.

### Layouts

- **Flat file:** `~/.config/reika/skills/review.md` → `/review`
- **Directory with `SKILL.md`:** `~/.config/reika/skills/review/SKILL.md` → `/review`. This lets a skill
  carry supporting files (scripts, reference docs). It is the layout other harnesses use, so you can
  drop their skill folders in as they are. `SKILL.md` is the prompt body. When the directory holds other files, the body
  opens with a line naming the skill's directory and listing those files (names only, up to 20, no
  dotfiles). A reference in the body to one of those files is rewritten to its full path, so
  `sh scripts/extract.sh` runs the skill's script rather than looking in your project. Nothing
  else in the body changes. Reika never runs a skill's scripts itself: the model runs them through
  `bash`, behind the same approval prompt and sandbox as any other command.

### File format

Plain markdown with optional YAML frontmatter:

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

Without frontmatter, the first non-empty line becomes the autocomplete description and the whole file is
the prompt body.

Reika reads `description`, `triggers` and `requires`. Frontmatter written for other harnesses
(such as `allowed-tools` or `model`) is ignored. A skill never pre-approves a tool: the commands it leads to
go through the approval prompt and the sandbox like any other.

**Invocation:**

- `/review` sends the file body as your input
- `/review focus on the API changes` appends the extra text to the body, after a blank line
- `/skills` lists available skills

### Plain-English routing (`triggers`)

You don't have to remember the slash command. `triggers:` lists phrases that route an ordinary prompt to
the skill. Reika matches them itself, **deterministically**; the model never decides. Writing "review the branch
for me" gets you a one-line hint that `/review` exists and that the prompt was sent unchanged; the turn
runs normally either way.

The frontmatter accepts any YAML list shape (`triggers: a, b`, `triggers: [a, b]`, or a `- ` block
list). The skill's own name is always an implicit trigger, so a skill called `verify` routes "verify my
changes" with no `triggers:` at all.

Matching rules, in short:

- Whole words only: a skill named `test` does not fire on "latest"
- Multi-word phrases score higher than single words; phrases under 3 characters are ignored
- A tie between two skills suggests neither (routing by array order would be arbitrary)
- Continuations such as `yes`, `ok`, `continue` and `do it` never route
- A skill is suggested at most once per session; decline it once and it stops asking

### Confirm-to-apply

`REIKA_SKILL_AUTO` (default `ask`) controls this. On a strong match, a two-row dialog opens over the
input before anything is sent: `1. Send as typed` (selected) and `2. Apply /review`, with your prompt
still in the box underneath. ↑↓, the digits and `y`/`n` move the cursor (`y` lands on Apply), Enter answers,
and ctrl-c drops the submit and leaves the prompt for you to edit.

- **Applying** prepends the skill body to your prompt, with a scrollback receipt naming which phrases
  matched. **Declining** sends it as typed, with no hint line.
- **Strong** means the prompt has the shape of a command, not just its keywords: two distinct triggers,
  or one multi-word phrase opening the prompt (a `please` / `can you` lead is fine). So `review pr 420
but first explain how the recap is built` asks, while `there is an issue with the pr review flow` only
  suggests.
- It is **refused** when the body would take more than ~15% of the context window, and never offered in
  chat mode, which has no `bash` for a skill's first step. Plan mode asks like the others, and its own
  prompt keeps the model planning the skill's steps rather than carrying them out.
- A prompt submitted while a turn is running is asked about right then, and the queued entry carries
  your answer to the replay.
- **Headless has nobody to ask,** so `ask` sends the prompt as typed there. `REIKA_SKILL_AUTO=apply` (or
  `1`) lets `-p` apply a strong match without asking, but only when the prompt is 12 words or fewer,
  since nobody is there to catch a wrong pick. The TUI still asks under `apply`: when someone is there,
  the skill is never applied silently. `off` leaves only the hint line.

It is on by default because a wrong pick now costs one keystroke rather than a turn.

### Pasted URLs

Paste an `http(s)` link into a prompt and Reika can fetch it before the turn starts, prepending the
extracted content as a `<url href="…">` block. It works like an `@file` mention, so the model reads
the page instead of guessing at it. Up to 2 URLs per prompt, truncated to 8k characters each
(`fetch_url` gets the rest). Every fetch leaves a scrollback line, and a dead link is reported as one
rather than silently dropped.

A link is fetched without asking only when it is what the prompt is about: the link on its own, or a
short request like "read this link" or "summarize https://…". A link that just happens to be in the
prompt, such as one in a pasted error or log, gets a confirm dialog first, since opening some links
(an unsubscribe or confirm link) already does something. `REIKA_PASTE_FETCH` sets this: `ask` (the
default) asks in the TUI and leaves the link alone in headless runs, `apply` still asks in the TUI
but fetches without asking in headless runs, and `off` never fetches, which is worth setting on an airgapped machine. A URL with credentials
in it (`https://user:pass@host`) is never fetched.

Only URLs _you_ type are fetched. Links inside an `@`-mentioned file are file content, and links the
model writes are handled separately by URL grounding (`REIKA_URL_GROUNDING`).

### Rules

- Built-in commands always win over skills with the same name, so you can't shadow `/help` or `/exit`
- Skill names are lowercased filenames; only `[a-z0-9_-]` are accepted, and files with other names are
  skipped
- Skills load at startup and on `/cd`; after editing one mid-session, run `/cd .` to reload
- Files under `<cwd>/.reika/` (such as `.reika/skills/` and `.reika/handoff/`) appear in `@`
  autocomplete, which is handy for inlining a project-local handoff doc, an in-repo skill file, or any
  other Reika scratch file. Other dot-directories, like `.git/` and `.vscode/`, stay hidden.
