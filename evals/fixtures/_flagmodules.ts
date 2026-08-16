import type { Message } from '../../src/types.js';
import type { AssertResult } from '../types.js';
import { callsAfterSpill, lastAssistantContent, readsSpill, spilledPath } from '../util.js';

// Shared corpus for the two grep-spill fixtures. They differ only in the tool set, so the corpus
// has to be byte-identical or the comparison means nothing — that's why this is extracted rather
// than duplicated per the usual rule-of-five.
//
// Six flag-bearing modules at 25 matches each = 150, against grep's 100-match inline page.
// Verified: the page covers four modules and two exist ONLY in the spill file, so naming all six
// proves the tail crossed into context. Readdir order decides *which* two are cut, not that two
// are, so there's no ordering dependence. The decoys keep a bare file listing from answering the
// prompt, and no filename hints at flags.

export const BEARERS = ['telemetry', 'scheduler', 'renderer', 'transport', 'indexer', 'migrator'];
export const DECOYS = ['palette', 'geometry', 'clipboard', 'easing'];

// Matches sit 8 lines apart so each becomes its own ±2-line context block. Adjacent matches would
// merge into one range, and the inline cut lands on a range boundary — one giant merged range
// would carry all 25 past the cut together instead of splitting the file.
function bearerModule(name: string): string {
  const lines: string[] = [`// ${name} module`, ''];
  for (let i = 1; i <= 25; i++) {
    lines.push(`export const FLAG_${name.toUpperCase()}_${String(i).padStart(2, '0')} = ${i};`);
    for (let p = 0; p < 7; p++) lines.push(`// ${name} padding ${i}.${p}`);
  }
  return lines.join('\n');
}

function decoyModule(name: string): string {
  const lines: string[] = [`// ${name} module`, ''];
  for (let i = 1; i <= 20; i++) lines.push(`export const ${name}Value${i} = ${i};`);
  return lines.join('\n');
}

export function flagModuleSetup(): Record<string, string> {
  const setup: Record<string, string> = {};
  for (const n of BEARERS) setup[`src/${n}.ts`] = bearerModule(n);
  for (const n of DECOYS) setup[`src/${n}.ts`] = decoyModule(n);
  return setup;
}

export const FLAG_PROMPT =
  'Some modules in src/ define constants named FLAG_*. List every file that defines at least ' +
  'one, by filename. Be exhaustive — I need all of them.';

// Shared assertion: did the model read the spill artifact back, and did the tail reach the answer?
// Naming the missing modules is the oracle — two of the six exist only in the saved result.
//
// Deliberately no decoy check. An earlier version failed a run for mentioning the decoys, but the
// check was `text.includes(name)` over the whole answer, which cannot tell "palette defines flags"
// from "palette does not" — a correct answer that listed exclusions failed identically to a wrong
// one. The six-bearer check already carries the oracle; the decoys earn their place in the corpus
// (they stop a bare file listing from answering the prompt) without needing an assertion.
export function assertSpillFollowed(messages: Message[]): AssertResult {
  const path = spilledPath(messages);
  if (!path) {
    return {
      pass: false,
      reason: 'no grep result was spilled (REIKA_SPILL off, or grep never ran / never capped)',
    };
  }

  const after = callsAfterSpill(messages, path);
  const followed = after.findIndex(c => readsSpill(c, path));
  if (followed < 0) {
    const next = after[0];
    const alt = !next
      ? 'answered from the capped page without following up'
      : next.name === 'grep' || next.name === 'glob'
        ? `re-ran ${next.name} instead of following the locator`
        : `routed around it via ${next.name}`;
    return { pass: false, reason: `did not read the spill file — ${alt}` };
  }

  const text = (lastAssistantContent(messages) ?? '').toLowerCase();
  const missing = BEARERS.filter(n => !text.includes(n));
  if (missing.length > 0) {
    return { pass: false, reason: `read the spill file but missed ${missing.join(', ')}` };
  }
  return { pass: true, note: `followed the locator after ${followed} other call(s)` };
}
