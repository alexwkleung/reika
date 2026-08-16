import type { Fixture } from '../types.js';
import { callsAfterSpill, lastAssistantContent, readsSpill, spilledPath } from '../util.js';

// Tests REIKA_SPILL (tools/_spill.ts): when a grep is capped, does the model read the saved
// result back, or re-run the search? Needs the flag on — with it off nothing is spilled and the
// fixture reports that rather than failing as if the model misbehaved.
//
// Six flag-bearing modules at 25 matches each = 150, against grep's 100-match inline page. The
// page therefore covers four modules and the last two exist ONLY in the spill file, so naming all
// six is proof the tail crossed into context — no dependence on readdir order, which decides
// *which* two are cut but not that two are. Four decoy modules keep a bare file listing from
// answering the question, and no filename hints at flags.

const BEARERS = ['telemetry', 'scheduler', 'renderer', 'transport', 'indexer', 'migrator'];
const DECOYS = ['palette', 'geometry', 'clipboard', 'easing'];

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

const setup: Record<string, string> = {};
for (const n of BEARERS) setup[`src/${n}.ts`] = bearerModule(n);
for (const n of DECOYS) setup[`src/${n}.ts`] = decoyModule(n);

export const fixture: Fixture = {
  name: 'grep-spill',
  setup,
  prompt:
    'Some modules in src/ define constants named FLAG_*. List every file that defines at least ' +
    'one, by filename. Be exhaustive — I need all of them.',
  assert: ({ messages }) => {
    const path = spilledPath(messages);
    if (!path) {
      return {
        pass: false,
        reason: 'no grep result was spilled (REIKA_SPILL off, or grep never ran / never capped)',
      };
    }

    // The experiment: what the model does with the locator it was just handed.
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

    // Oracle: the last two modules exist only in the saved result, so an exhaustive list is proof
    // the tail actually arrived — not just that the file was opened at some offset.
    const text = (lastAssistantContent(messages) ?? '').toLowerCase();
    const missing = BEARERS.filter(n => !text.includes(n));
    if (missing.length > 0) {
      return { pass: false, reason: `read the spill file but missed ${missing.join(', ')}` };
    }
    const falsePositives = DECOYS.filter(n => text.includes(n));
    if (falsePositives.length > 0) {
      return { pass: false, reason: `named decoy module(s): ${falsePositives.join(', ')}` };
    }
    return { pass: true, note: `followed the locator after ${followed} other call(s)` };
  },
};
