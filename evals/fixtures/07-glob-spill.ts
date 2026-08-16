import type { Fixture } from '../types.js';
import { callsAfterSpill, lastAssistantContent, readsSpill, spilledPath } from '../util.js';

// The glob half of the REIKA_SPILL test. Untestable against reika itself — the repo is ~175 files
// against a 200-path cap — so the corpus is synthetic, which is the whole reason this belongs in a
// fixture rather than a manual run.
//
// 260 modules sorted lexicographically against glob's 200-path inline page. The page ends inside
// the `mod_*` block, so everything from SENTINEL on exists only in the spill file. Asking for the
// LAST path alphabetically makes the tail necessary: the count alone is free from the summary
// line, but the final entry is not.

const SENTINEL = 'zzz_final_module';

const setup: Record<string, string> = {};
for (let i = 0; i < 259; i++) {
  setup[`src/mod_${String(i).padStart(3, '0')}.ts`] = `export const value${i} = ${i};\n`;
}
setup[`src/${SENTINEL}.ts`] = 'export const last = true;\n';

export const fixture: Fixture = {
  name: 'glob-spill',
  setup,
  prompt:
    'Using a glob over src/, what is the name of the very last .ts file alphabetically? ' +
    'Give me just the filename.',
  assert: ({ messages }) => {
    const path = spilledPath(messages);
    if (!path) {
      return {
        pass: false,
        reason: 'no glob result was spilled (REIKA_SPILL off, or glob never ran / never capped)',
      };
    }

    const after = callsAfterSpill(messages, path);
    const followed = after.findIndex(c => readsSpill(c, path));
    if (followed < 0) {
      const next = after[0];
      const alt = !next
        ? 'answered from the capped page without following up'
        : next.name === 'glob' || next.name === 'grep'
          ? `re-ran ${next.name} instead of following the locator`
          : `routed around it via ${next.name}`;
      return { pass: false, reason: `did not read the spill file — ${alt}` };
    }

    // The sentinel sorts past the 200th path, so it reaches the answer only through the spill file.
    const text = lastAssistantContent(messages) ?? '';
    if (!text.includes(SENTINEL)) {
      return { pass: false, reason: `read the spill file but did not report ${SENTINEL}` };
    }
    return { pass: true, note: `followed the locator after ${followed} other call(s)` };
  },
};
