---
description: read a GitHub issue with gh, then work on it
triggers: work on issue, gh issue, fix issue, look at issue, issue number
---

Your first action is a `bash` tool call. Call the `bash` tool with this command:

    gh issue view <number> --json title,state,body,comments

Replace `<number>` with the issue number at the end of this message.

The text of the issue exists only in the output of that command. No other tool
has it, and no file in this repository contains it. Until the `bash` call
returns, you do not know what the issue says.

Reading the output: it is JSON. `body` is often empty — that is normal and does
not mean the command failed. When `body` is empty, the issue's actual content is
in the `comments` array. Read the title and every comment before deciding what
the issue asks for. Do not re-run the command to get a fuller result; this
output is complete.

Once you have the issue text, work on what it asks for.

Issues here often raise explicit open questions, or list several sub-items. If you
resolve one by choosing — picking one option, deferring it, or leaving it out — say
so where the work is reported: the PR body, or your final message if there is no PR.
A silent choice is indistinguishable from an oversight to whoever reads it next, and
they have to re-derive the whole question to find out which it was.

That covers sub-items you can settle yourself. One thing you cannot settle by reading is
an issue that contradicts a decision the repository has already made — an existing
implementation, a comment, a commit message explaining why something was deliberately
left out. Re-reading the code will not resolve that, because the code is one half of the
contradiction. Ask instead: call `ask_user` once, with the readings as the options.

Stopping to ask is a legitimate outcome here. Guessing which way the author meant it is
not — a wrong guess costs more than the question does, because the work built on it has
to be thrown away rather than adjusted.

Issue number:
