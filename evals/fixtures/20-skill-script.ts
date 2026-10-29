import type { Fixture } from '../types.js';
import { lastAssistantContent } from '../util.js';

// Does a model run a skill's script from the skill's own directory (#861)? A skill written for
// another harness names its files relative to itself ("run `scripts/tally.sh`"); the project has no
// `scripts/`, so a model that resolves the path against the cwd gets "No such file" and has to
// recover or give up. (An anchor line alone found the script but lfm ran the body's literal
// relative command anyway, 1/3; the loader now rewrites references to full paths.) The skill sits in the global skills dir, outside the project: placed under
// `.reika/skills` it was found by `find .` with no anchor at all (baseline 3/3 passed), which
// measured nothing. The anchor line the loader prepends names the skill directory; this measures
// whether the model uses it. The token the script prints depends on the data file's line count, so
// it cannot be guessed — a correct answer means the script ran.
//
// The note says how the first call that runs the script was shaped: `anchored` (the skill
// directory's path), `cd-skill-dir` (a `cd` into the skill directory, which also moves the user's
// own relative arguments — `data.txt` stops resolving), `relative` (cwd-relative, the pre-#861
// failure), or none. Baseline is the same fixture on a build
// without the anchor. Read 3+ runs per model.

const LINES = 37;
const TOKEN = `tally=${LINES * 13 + 5}-k9`;

export const fixture: Fixture = {
  name: 'skill-script',
  globalSkills: {
    'tally/SKILL.md': [
      '---',
      'description: Tally a data file with the bundled script',
      '---',
      '',
      'Run `sh scripts/tally.sh <file>` on the file named below and report the line it prints, verbatim.',
      'Do not compute the tally yourself.',
    ].join('\n'),
    'tally/scripts/tally.sh': [
      '#!/bin/sh',
      'n=$(wc -l < "$1" | tr -d " ")',
      'echo "tally=$((n * 13 + 5))-k9"',
      '',
    ].join('\n'),
  },
  setup: {
    'data.txt': Array.from({ length: LINES }, (_, i) => `row ${i + 1}`).join('\n') + '\n',
  },
  prompt: '/tally data.txt',
  timeoutMs: 10 * 60 * 1000,
  assert: ({ messages }) => {
    const commands = messages.flatMap(m =>
      m.role === 'assistant'
        ? (m.toolCalls ?? [])
            .filter(tc => tc.name === 'bash')
            .map(tc => String(tc.args.command ?? ''))
        : [],
    );
    // The first call that RUNS the script: a `cat` of it is the model reading it, not using the path.
    const first = commands.find(c => /tally\.sh/.test(c) && !/^\s*(cat|head|tail|less)\b/.test(c));
    const shape = !first
      ? 'none'
      : /\bcd\s+\S*\/tally\/?(\s|&|;|$)/.test(first)
        ? 'cd-skill-dir'
        : /\/tally\/scripts\/tally\.sh/.test(first)
          ? 'anchored'
          : 'relative';
    const note = `first script call: ${shape}; bash calls: ${commands.length}`;
    const reply = lastAssistantContent(messages) ?? '';
    if (!reply.includes(TOKEN)) {
      return { pass: false, reason: `reply lacks ${TOKEN} — ${note}` };
    }
    return { pass: true, note };
  },
};
