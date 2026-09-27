import type { Fixture } from '../types.js';
import { formatGrindSteps, scoreGrindSteps } from '../_grindsteps.js';
import { gradeHiddenChecks, type HiddenCheck } from '../_hiddenchecks.js';

// Grind mode (#556): one task, run under each mode (`npm run eval -- grind-chunk --mode=grind`, then
// `--mode=agent` and `--mode=minimal`), graded on two axes that are reported separately:
//
//  - the OUTCOME, by hidden asserts the visible tests do not cover. The report says "reject sizes
//    that can't make progress"; 0 is the case it names, and -1, NaN, 2.5, Infinity and a string are
//    the edge cases step 5 asks the model to find. The one a narrow fix misses on purpose is the
//    CALLER: `paginate` documents `pageSize 0` as "one page with every row", so a chunk() that now
//    throws on 0 breaks it — the thing step 6 (check the callers) exists to catch.
//  - the STEPS, from the transcript (`_grindsteps.ts`), so a run says which of the seven steps a
//    model took whether or not the answer came out right.
//
// Judge over 3+ runs per mode; the steps note is the interesting half.

const TARGET = 'src/chunk.js';

const CHUNK = [
  'export function chunk(items, size) {',
  '  const out = [];',
  '  for (let i = 0; i < items.length; i += size) {',
  '    out.push(items.slice(i, i + size));',
  '  }',
  '  return out;',
  '}',
  '',
].join('\n');

const PAGER = [
  "import { chunk } from './chunk.js';",
  '',
  '// Splits rows into pages for the table view. pageSize 0 means one page with every row.',
  'export function paginate(rows, pageSize = 10) {',
  '  return chunk(rows, pageSize);',
  '}',
  '',
].join('\n');

const TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { chunk } from '../src/chunk.js';",
  '',
  "test('splits into fixed-size chunks with a short tail', () => {",
  '  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);',
  '});',
  '',
  "test('returns no chunks for an empty list', () => {",
  '  assert.deepEqual(chunk([], 3), []);',
  '});',
  '',
].join('\n');

const HIDDEN_CHECKS: HiddenCheck[] = [
  ['size 0 rejected', 'throws(() => chunk([1, 2], 0))'],
  ['size -1 rejected', 'throws(() => chunk([1, 2], -1))'],
  ['size NaN rejected', 'throws(() => chunk([1, 2], NaN))'],
  ['size 2.5 rejected', 'throws(() => chunk([1, 2, 3], 2.5))', 'strict'],
  ['size Infinity rejected', 'throws(() => chunk([1, 2], Infinity))', 'strict'],
  ['size "2" rejected', "throws(() => chunk([1, 2], '2'))", 'strict'],
  ['normal chunks unchanged', 'same(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])'],
  ['size past length is one chunk', 'same(chunk([1, 2], 5), [[1, 2]])'],
  ['paginate(rows, 0) is one page', 'same(paginate([1, 2, 3], 0), [[1, 2, 3]])'],
  ['paginate default unchanged', 'same(paginate([1, 2, 3]), [[1, 2, 3]])'],
];

export const fixture: Fixture = {
  name: 'grind-chunk-guard',
  gitInit: true,
  setup: {
    'package.json': JSON.stringify(
      { name: 'rows', type: 'module', scripts: { test: 'node --test' } },
      null,
      2,
    ),
    [TARGET]: CHUNK,
    'src/pager.js': PAGER,
    'test/chunk.test.js': TEST,
  },
  prompt:
    "chunk() in src/chunk.js hangs forever when size is 0. Make it reject sizes that can't make progress.",
  // 30, not 15: a local 27B that checks its own work was cut off mid-check at 15 (#556).
  timeoutMs: 30 * 60 * 1000,
  assert: async ({ cwd, messages }) =>
    gradeHiddenChecks(
      cwd,
      { [TARGET]: ['chunk'], 'src/pager.js': ['paginate'] },
      HIDDEN_CHECKS,
      formatGrindSteps(scoreGrindSteps(messages, TARGET)),
    ),
};
