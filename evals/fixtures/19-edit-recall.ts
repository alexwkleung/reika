import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyEditMatch, type EditMatchKind } from '../../src/tools/edit.js';
import type { Message } from '../../src/types.js';
import type { AssertResult, Fixture } from '../types.js';

// How often does a small model mistype old_string, and would a patch-rebase have saved the edit?
// This sizes the edit self-heal idea (a derivative of #215) before anything is built: a rebase applies
// the model's (old_string → new_string) change onto the real bytes when only its copied CONTEXT lines
// were wrong, and must refuse when a misremembered line is echoed into new_string — applying that
// would write the hallucinated line back over the real one.
//
// The corpus is a table of near-identical route entries, so copying a few lines of context means
// copying lines that differ from their neighbours by one token. Two arms:
// - `edit-recall-live`: one turn, the model reads and edits with the bytes in context — transcription.
// - `edit-recall-aged`: the read happens in turn one, the edit in turn two, after the read payload
//   has aged — recall. The read-first gate (#72) bounces a blind edit here, so run this arm with
//   `REIKA_READ_FIRST=0` as well to see the raw rate; the gate is read at import, not per fixture.
//
// The verdict is the note, not pass/fail: a run that lands the right change still passes, and the
// note counts every edit call by how it matched (exact / fuzzy / diverged / absent / …) and, for the
// failures, whether a rebase was eligible (misremembered lines only in context) or would have had to
// refuse (a misremembered line echoed into new_string). Read 3+ runs per arm and model.

const TARGET = 'src/routes.ts';

const ROUTES: [string, string, number, boolean][] = [
  ['/users', 'listUsers', 3000, true],
  ['/users/:id', 'getUser', 3000, true],
  ['/orders', 'listOrders', 5000, false],
  ['/orders/:id', 'getOrder', 5000, true],
  ['/invoices', 'listInvoices', 5000, false],
  ['/invoices/:id', 'getInvoice', 3000, true],
  ['/payments', 'listPayments', 8000, false],
  ['/payments/:id', 'getPayment', 8000, true],
];

function routesModule(): string {
  const lines = [
    "import type { Route } from './types.js';",
    "import * as h from './handlers.js';",
    '',
    'export const routes: Route[] = [',
  ];
  for (const [path, handler, timeoutMs, retries] of ROUTES) {
    lines.push('  {');
    lines.push(`    path: '${path}',`);
    lines.push(`    handler: h.${handler},`);
    lines.push(`    timeoutMs: ${timeoutMs},`);
    lines.push(`    retries: ${retries},`);
    lines.push('  },');
  }
  lines.push('];', '');
  return lines.join('\n');
}

export const ROUTES_SOURCE = routesModule();

const SETUP: Record<string, string> = {
  [TARGET]: ROUTES_SOURCE,
  'src/types.ts': [
    'export type Route = {',
    '  path: string;',
    '  handler: (req: unknown) => Promise<unknown>;',
    '  timeoutMs: number;',
    '  retries: boolean;',
    '};',
    '',
  ].join('\n'),
};

const CHANGE =
  'change the `/orders` route (not `/orders/:id`) in src/routes.ts to timeoutMs 9000 and retries true';

export type EditCallReport = {
  kind: EditMatchKind;
  bounced: boolean;
  // Lines of old_string (trimmed, non-blank) that appear nowhere in the file at call time.
  misremembered: string[];
  // Of those, the ones new_string repeats — the reason a rebase would have to refuse.
  echoed: string[];
};

const trimmedLines = (s: string): string[] =>
  s
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '');

// Replays the model's edits against a simulated copy of the file, so each call is classified against
// the bytes it actually met. Only exact successes can be re-applied here; after any other success the
// copy may no longer match the real file, so the replay stops rather than misclassify what follows.
export function reportEditCalls(
  messages: Message[],
  initial: string,
): { calls: EditCallReport[]; lost: boolean } {
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool') results.set(m.callId, m.summary);
  }
  let text = initial;
  const calls: EditCallReport[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.toolCalls ?? []) {
      if (c.name !== 'edit' || !String(c.args.path ?? '').endsWith(TARGET)) continue;
      const oldStr = String(c.args.old_string ?? '');
      const newStr = String(c.args.new_string ?? '');
      const result = results.get(c.id) ?? '';
      const kind = classifyEditMatch(text, oldStr, newStr);
      const fileLines = new Set(trimmedLines(text));
      const misremembered = trimmedLines(oldStr).filter(l => !fileLines.has(l));
      const newLines = new Set(trimmedLines(newStr));
      calls.push({
        kind,
        bounced: result.startsWith('edit paused'),
        misremembered,
        echoed: misremembered.filter(l => newLines.has(l)),
      });
      if (/^Edited\b/.test(result)) {
        if (kind !== 'exact') return { calls, lost: true };
        text = text.replace(oldStr, newStr);
      }
    }
  }
  return { calls, lost: false };
}

function formatReport(calls: EditCallReport[], lost: boolean): string {
  if (calls.length === 0) return 'no edit calls on the target (changed it another way)';
  const parts = calls.map(c => {
    const tags: string[] = [c.kind];
    if (c.bounced) tags.push('bounced');
    if (c.misremembered.length > 0) {
      tags.push(
        c.echoed.length > 0 ? `rebase-refuse(${c.echoed.length} echoed)` : 'rebase-eligible',
      );
    }
    return tags.join('+');
  });
  return `edits: ${parts.join(', ')}${lost ? ' (replay stopped after a non-exact apply)' : ''}`;
}

function routeBlock(text: string, path: string): string | null {
  const at = text.indexOf(`path: '${path}',`);
  if (at === -1) return null;
  const end = text.indexOf('},', at);
  return end === -1 ? null : text.slice(at, end);
}

async function grade(cwd: string, messages: Message[]): Promise<AssertResult> {
  const { calls, lost } = reportEditCalls(messages, SETUP[TARGET]);
  const note = formatReport(calls, lost);
  const text = await readFile(join(cwd, TARGET), 'utf8');
  const orders = routeBlock(text, '/orders');
  if (!orders) return { pass: false, reason: `/orders entry missing or malformed; ${note}` };
  if (!orders.includes('timeoutMs: 9000') || !orders.includes('retries: true')) {
    return { pass: false, reason: `/orders not changed to 9000/true; ${note}` };
  }
  // Every other entry must be byte-identical to the setup: a misplaced edit is the targeting failure
  // a rebase does not fix, and it should not read as a pass.
  for (const [path] of ROUTES) {
    if (path === '/orders') continue;
    if (routeBlock(text, path) !== routeBlock(SETUP[TARGET], path)) {
      return { pass: false, reason: `${path} entry was modified too; ${note}` };
    }
  }
  return { pass: true, note };
}

export const liveFixture: Fixture = {
  name: 'edit-recall-live',
  setup: SETUP,
  prompt: `Read src/routes.ts, then ${CHANGE}.`,
  timeoutMs: 10 * 60 * 1000,
  assert: ({ cwd, messages }) => grade(cwd, messages),
};

export const agedFixture: Fixture = {
  name: 'edit-recall-aged',
  setup: SETUP,
  prompt:
    'Read src/routes.ts and tell me which routes have retries disabled. Do not change anything yet.',
  followUp: `Now ${CHANGE}.`,
  timeoutMs: 15 * 60 * 1000,
  assert: ({ cwd, messages }) => grade(cwd, messages),
};
