import type { Fixture } from '../types.js';
import { formatGrindSteps, scoreGrindSteps } from '../_grindsteps.js';
import { gradeHiddenChecks, type HiddenCheck } from '../_hiddenchecks.js';

// The harder arm of 16-grind-chunk-guard (#556), same prompt. On deepseek-v4.1-flash, 16 passed 2/3
// in plain agent mode and every mode found its one caller: in a four-file repo a grep for `chunk`
// lands on it. Here the callers are reached only through an alias:
//
//  - `src/util/index.js` re-exports chunk as `splitEvery`, so `grep 'chunk('` finds the definition
//    and the test and nothing else; the callers import `splitEvery`.
//  - `paginate` documents `pageSize 0` as one page with every row (16's trap, now behind the alias).
//  - `assign` sizes its chunks as `Math.ceil(jobs.length / workers)`, which is 0 for an empty job
//    list. Today that returns [] because the loop never runs; a fix that validates size before
//    looking at the input makes `assign([], n)` throw. Only a model that reads the caller and asks
//    what it passes in finds this one — step 6 in grind's procedure.
//
// Run it next to 16: `npm run eval -- grind-chunk --mode=<m>` matches both.

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

const UTIL_INDEX = [
  "export { chunk as splitEvery } from '../chunk.js';",
  '',
  'export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));',
  '',
].join('\n');

const PAGER = [
  "import { splitEvery } from './util/index.js';",
  '',
  '// Splits rows into pages for the table view. pageSize 0 means one page with every row.',
  'export function paginate(rows, pageSize = 10) {',
  '  return splitEvery(rows, pageSize);',
  '}',
  '',
].join('\n');

const WORKERS = [
  "import { splitEvery } from './util/index.js';",
  '',
  '// Spreads jobs as evenly as possible across a fixed number of workers.',
  'export function assign(jobs, workers) {',
  '  return splitEvery(jobs, Math.ceil(jobs.length / workers));',
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
  ['paginate(rows, 0) is one page', 'same(paginate([1, 2, 3], 0), [[1, 2, 3]])'],
  ['paginate default unchanged', 'same(paginate([1, 2, 3]), [[1, 2, 3]])'],
  ['assign([], n) is no batches', 'same(assign([], 4), [])'],
  ['assign spreads jobs', 'same(assign([1, 2, 3, 4, 5], 2), [[1, 2, 3], [4, 5]])'],
];

export const fixture: Fixture = {
  name: 'grind-chunk-hidden',
  gitInit: true,
  setup: {
    'package.json': JSON.stringify(
      { name: 'rows', type: 'module', scripts: { test: 'node --test' } },
      null,
      2,
    ),
    [TARGET]: CHUNK,
    'src/util/index.js': UTIL_INDEX,
    'src/pager.js': PAGER,
    'src/workers.js': WORKERS,
    'test/chunk.test.js': TEST,
  },
  prompt:
    "chunk() in src/chunk.js hangs forever when size is 0. Make it reject sizes that can't make progress.",
  // 30, not 15: a local 27B that checks its own work was cut off mid-check at 15 (#556).
  timeoutMs: 30 * 60 * 1000,
  assert: async ({ cwd, messages }) =>
    gradeHiddenChecks(
      cwd,
      { [TARGET]: ['chunk'], 'src/pager.js': ['paginate'], 'src/workers.js': ['assign'] },
      HIDDEN_CHECKS,
      formatGrindSteps(scoreGrindSteps(messages, TARGET)),
    ),
};
