---
description: read a GitHub pull request with gh, then review the diff
triggers: review pr, pr review, review the pull request, pull request, code review
---

Your first action is a `bash` tool call. Call the `bash` tool with this command:

    gh pr view <number> --json title,state,body,comments

Replace `<number>` with the PR number at the end of this message. If no number
appears there, drop it entirely and run `gh pr view --json title,state,body,comments`
— with no number, `gh` uses the pull request for the current branch.

A pull request usually closes an issue, and the issue is where the problem was
first described. The PR body is written assuming you have read it. Make a second
`bash` call:

    gh pr view <number> --json closingIssuesReferences --jq '.closingIssuesReferences[].number' | xargs -I{} gh issue view {} --json number,title,body,comments

Empty output means this PR links no issue. That is normal, not a failure — go
straight on to the diff.

If output comes back it is the linked issue, in the same JSON shape as before:
`body` may be empty, and then the content is in `comments`. The issue may itself
reference other numbers (`#179`, `#185`). Do not go read those. One level is
enough.

Then, before any other call, write one or two sentences in your reply saying what
the issue asks for — not what the PR does, the requirement. Later tool output can
push the issue text out of your context; that sentence is what stays.

Then make a third `bash` call for the change itself:

    gh pr diff <number>

The pull request exists only in the output of `gh pr view` and `gh pr diff`. No
other tool has it, and no file in this repository contains it. Until they return,
you do not know what this PR changes.

Then a fourth call, for the file list:

    gh pr diff <number> --name-only

Treat that list as complete. A file not on it is not part of this PR, no matter
what you remember reading in the diff. Check it for tests: if the PR changes how
code behaves and no test file on the list covers that code, say so as a finding.

Then a fifth call, for CI:

    gh pr checks <number>

This exits non-zero when a check is failing or still running, and prints "no
checks reported" when there is no CI — none of that means the command failed.
A failing check goes first in your review, named as it appears in the output.

Reading the output. `gh pr view` returns JSON, and `body` is often empty — that
is normal and does not mean the command failed. When `body` is empty, the
description is in the `comments` array. `gh pr diff` returns a unified diff:
`-` lines are being removed, `+` lines are being added, everything else is
unchanged context shown for orientation.

If the diff output ends with `…(truncated)`, you have not seen all of it. Do not
re-run the same command — it truncates the same way every time. Find out how
long the diff is, then page through it 300 lines at a time:

    gh pr diff <number> | wc -l
    gh pr diff <number> | sed -n '1,300p'
    gh pr diff <number> | sed -n '301,600p'

Keep going until the last line number you have read reaches the count from
`wc -l`. Review each page as you get it.

A diff shows only the lines that changed, never the code around them. Before
calling something broken, open the file with the `read` tool and look at the
surrounding code. Most wrong review findings come from judging a hunk in
isolation — the variable you think is undefined is usually defined ten lines up.

The files on disk are not the PR's version. They are whatever branch is checked
out locally, usually the code before this PR. Use `read` only for the unchanged
code around a hunk. Expect the `+` lines to be missing from the file, and files
this PR adds not to exist at all — that is not a finding, and not a reason to
investigate. What the PR changes comes from the diff alone.

If the diff renames a function, changes its parameters, or changes what it
returns, `grep` for its name. Because the files on disk are the code before this
PR, every call site grep finds is one that existed before the change. A call
site in a file that is not on the PR's file list was not updated — that is a
finding. One grep per changed function — that grep is the only caller search to
run.

The PR body and the diff's own comments make claims about what the code does
("runs whenever X", "only bypasses Y", "unchanged for Z"). Check each claim
against the code it describes, following a condition into the function it
calls when the claim depends on it. A claim the code does not keep is a finding.

Then write the review. For each finding, give the file and line, what is wrong,
and why it matters. Put the most serious first: correctness bugs, data loss, and
security problems outrank style and naming. If the change is sound, say so
plainly rather than inventing findings — "no blocking issues" is a real review.

Do not restate the diff, re-explain what the code does, or narrate how you found
something — the reader has the PR open in front of them. Say what is wrong and why
it matters, and stop. Length is not thoroughness: on a slow local model every
sentence is real wall-clock time, and a review that takes twice as long to read is
not twice as useful.

Review the change against that requirement, not only against the PR body. Two
findings only that step can produce: the diff does something the issue never
asked for, and the diff misses something the issue did ask for.

Do not edit any files, and do not post anything to GitHub. This review is for
the terminal; the user decides what to do with it.

PR number:
