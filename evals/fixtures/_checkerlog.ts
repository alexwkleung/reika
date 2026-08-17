import { readFile } from 'node:fs/promises';
import type { Message } from '../../src/types.js';
import type { AssertResult } from '../types.js';
import { callsAfterSpill, lastAssistantContent, readsSpill, spilledPath } from '../util.js';

// Shared corpus for the two bash-spill fixtures (#139). Both run the same checker over the same
// modules and differ only in what its LAST line says, so the ~200KB of chatter that fills the
// payload is byte-identical between them and the comparison is about the tail alone — the same
// reason `_flagmodules.ts` is extracted rather than duplicated.
//
// The shape is the one bash spill exists for: a long run whose interesting output is at the end.
// 3264 lines of passing checks bury the verdict roughly 3x past the 64KB payload cap, so the head
// the model sees is entirely "ok, ok, ok" and the verdict lives only in the spilled tail.

const BUDGET = 150;
// One module over the budget, the rest comfortably under, so the checker's verdict is unambiguous.
const MODULES: Array<[string, number]> = [
  ['transport', 188],
  ['telemetry', 140],
  ['scheduler', 96],
  ['renderer', 88],
  ['indexer', 71],
  ['migrator', 64],
  ['palette', 47],
  ['easing', 39],
];

export const FLAGGED_FILE = 'transport';
export const FLAGGED_LINES = 188;

function module(name: string, lines: number): string {
  const out: string[] = [`// ${name} module`, ''];
  // `lines` is the file's real line count — the checker measures it with `wc -l`, so it has to be
  // exact. Note the trailing newline: wc counts newlines, so without it every file would measure
  // one short and the oracle number would be off by one.
  for (let i = out.length; i < lines; i++) {
    out.push(`export const ${name}Value${i} = ${i};`);
  }
  return `${out.join('\n')}\n`;
}

// 12 rule sets x 34 rules x 8 modules = 3264 lines of chatter at ~62 bytes each (~200KB). Every
// line is distinct (pass, rule, and file all vary) so the payload isn't a block of identical text
// the rumination detectors would read as a loop.
const CHATTER = [
  'echo "checkerd 2.4.1 — 8 modules, 12 rule sets"',
  'pass=1',
  'while [ $pass -le 12 ]; do',
  '  n=1',
  '  while [ $n -le 34 ]; do',
  '    for f in src/*.ts; do',
  '      echo "[pass $pass/12] rule $n/34: $f — ok (0 findings, 0 suppressed)"',
  '    done',
  '    n=$((n + 1))',
  '  done',
  '  pass=$((pass + 1))',
  'done',
  'echo ""',
  'echo "=== summary ==="',
  'echo "3264 checks run, 0 findings from rule sets 1-34"',
].join('\n');

// The verdict is COMPUTED at run time (wc over the tree) rather than written into the script, so
// `cat ci/check.sh` cannot answer the prompt. Replicating the computation with another command
// still can — that route-around is real and the fixture is built to record it, not to block it.
const VERDICT_TAIL = [
  `worst=$(wc -l src/*.ts | grep -v ' total$' | sort -rn | head -1)`,
  `file=$(echo "$worst" | awk '{print $2}')`,
  `count=$(echo "$worst" | awk '{print $1}')`,
  `echo "FAIL: $file exceeds the size budget ($count lines > ${BUDGET})"`,
  'echo "checkerd exit 1"',
  'exit 1',
].join('\n');

// A per-run seed from /dev/urandom, not awk's srand() — srand() seeds off the clock in whole
// seconds, so two runs in the same second would produce the same value and the re-run/read-back
// distinction this fixture rests on would silently stop discriminating.
const SEED_TAIL = [
  'seed=$(od -An -N4 -tu4 < /dev/urandom | tr -d " ")',
  `echo "FAIL: property test 'merge_idempotent' failed after 4096 cases (seed $seed)"`,
  'echo "checkerd exit 1"',
  'exit 1',
].join('\n');

export function checkerSetup(tail: 'verdict' | 'seed'): Record<string, string> {
  const setup: Record<string, string> = {};
  for (const [name, lines] of MODULES) setup[`src/${name}.ts`] = module(name, lines);
  setup['ci/check.sh'] = `${CHATTER}\n${tail === 'verdict' ? VERDICT_TAIL : SEED_TAIL}\n`;
  return setup;
}

export const CHECK_PROMPT_PREFIX = 'Run the checker with `sh ci/check.sh`. It exits non-zero. ';

// Both fixtures share the first half of the question — was anything spilled, and did the model go
// back for it — and differ only in the oracle. `reason` records what it did INSTEAD when it didn't
// follow, since for bash the alternative (re-run the command, narrowed) is usually available and
// knowing which one it reached for is the actual finding.
type Failure = { pass: false; reason: string };
type Followed = { path: string; after: number } | { fail: Failure };

export function spillFollowUp(messages: Message[]): Followed {
  const path = spilledPath(messages);
  if (!path) {
    return {
      fail: {
        pass: false,
        reason:
          'nothing was spilled (REIKA_SPILL off, the command never ran, or its output never ' +
          'passed the payload cap)',
      },
    };
  }
  const after = callsAfterSpill(messages, path);
  const followed = after.findIndex(c => readsSpill(c, path));
  if (followed < 0) {
    const next = after[0];
    const alt = !next
      ? 'answered from the capped head without following up'
      : next.name === 'bash'
        ? `re-ran a command instead of reading the artifact (${String(next.args.command ?? '')})`
        : `routed around it via ${next.name}`;
    return { fail: { pass: false, reason: `did not read the spill file — ${alt}` } };
  }
  return { path, after: followed };
}

// How many times the checker itself was executed. One run means every claim about its output had
// to come from that run's payload or its artifact; more than one means a fresh execution supplied
// whatever the model quoted.
function checkerRuns(messages: Message[]): number {
  return messages.reduce(
    (n, m) =>
      m.role !== 'assistant'
        ? n
        : n +
          (m.toolCalls ?? []).filter(
            c => c.name === 'bash' && String(c.args.command ?? '').includes('check.sh'),
          ).length,
    0,
  );
}

// #139's own question, not the search tools': did the tail reach the answer? The verdict names a
// file and a line count that appear nowhere in the 64KB head, so a correct answer proves the
// spilled bytes crossed into context.
export function assertCheckerVerdict(messages: Message[]): AssertResult {
  const step = spillFollowUp(messages);
  const text = (lastAssistantContent(messages) ?? '').toLowerCase();
  const correct = text.includes(FLAGGED_FILE) && text.includes(String(FLAGGED_LINES));
  if ('fail' in step) {
    // Worth distinguishing: routing around and still answering correctly is a different result
    // from routing around and getting it wrong, and the bare reason string would hide that.
    return {
      pass: false,
      reason: `${step.fail.reason} — answer was ${correct ? 'still correct' : 'wrong too'}`,
    };
  }
  if (!correct) {
    return {
      pass: false,
      reason: `read the spill file but did not name ${FLAGGED_FILE}.ts / ${FLAGGED_LINES} lines`,
    };
  }
  return { pass: true, note: `followed the locator after ${step.after} other call(s)` };
}

// The one-shot variant's oracle. The seed exists only in that run's output, so it cannot be
// recomputed, re-derived, or found in a file — a re-run produces a DIFFERENT seed, which is what
// makes this the arm that isolates locator-following from bash's usual escape hatch.
export async function assertRunSeed(messages: Message[]): Promise<AssertResult> {
  const step = spillFollowUp(messages);
  const path = 'fail' in step ? spilledPath(messages) : step.path;
  const seed = path ? /seed (\d+)/.exec(await readFile(path, 'utf8'))?.[1] : undefined;
  const text = lastAssistantContent(messages) ?? '';
  // Anchored on the word rather than any long number, so a byte count quoted from the footer
  // isn't misreported as the seed the model claimed.
  const claimed = /seed\D{0,20}(\d{4,})/i.exec(text)?.[1];

  if ('fail' in step) {
    // The baseline arm lands here (flag off ⇒ nothing spilled), and what the model does with an
    // unanswerable question is the whole point of running it: declining is the correct outcome,
    // and a confident fabricated seed is a worse failure than no answer at all.
    //
    // With nothing spilled there is no artifact to check the claim against, so the disambiguator
    // is whether it ran the checker more than once: a second run genuinely prints a seed (a real
    // if different one), while a seed quoted after a single run cannot have been seen at all —
    // the line sits past the payload cap — and is therefore fabricated.
    const said = !claimed
      ? 'reported no seed (correct — it had none)'
      : checkerRuns(messages) > 1
        ? `reported ${claimed} from a narrowed re-run, not from the run it was asked about`
        : `FABRICATED seed ${claimed} — it never saw one`;
    return { pass: false, reason: `${step.fail.reason} — ${said}` };
  }
  if (!seed) return { pass: false, reason: 'the spilled output carried no seed line' };

  if (text.includes(seed)) {
    return { pass: true, note: `reported the seed from its own run after ${step.after} call(s)` };
  }
  return {
    pass: false,
    reason: claimed
      ? `reported seed ${claimed}, but its run printed ${seed} — a later re-run, not the artifact`
      : 'read the spill file but never reported the seed',
  };
}
