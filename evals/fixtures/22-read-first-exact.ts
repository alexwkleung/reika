import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../../src/types.js';
import type { AssertResult, Fixture } from '../types.js';

// What does the read-first bounce buy that an exact old_string cannot (#932)? An exact match proves
// the model holds those bytes, not that it has seen what changed around them, so this builds that
// worst case. Turn one quotes the `/orders` entry, which puts its exact bytes in the model's own
// reply, where the gate does not count them. Between turns the fixture appends an override below the
// table, leaving the entry byte-identical, the way an editor or formatter would, so nothing tells the
// model the file changed. Turn two asks for a runtime change the override defeats. A bounce sends the
// model to re-read and meet the override; a bypass lands the edit without it.
//
// A first draft had the model run the sync script itself. It then re-read on its own, so the gate
// never fired, and it walked past the override it had just read anyway.
//
// Run with `REIKA_PREFIX_STABLE=0`: with a window the read stays live across turns and the gate never
// fires. The arms are `REIKA_READ_FIRST_EXACT=0` (bounce) and unset (bypass), both read at import.
// The table is over the 2048-char aged floor, or the aged read would keep the whole file in context.
// The trap is built, so a difference between arms shows the mechanism, never how often it happens.
// Read the note: a run that re-read anyway, or whose edit missed, says nothing about the bypass.
//
// Measured 2026-11-07, 3 runs per arm, `REIKA_PREFIX_STABLE=0`. lfm2.5-24b-a2b-eval (llama.cpp):
// bounce 0/3, bypass 1/3. deepseek-v4.1-flash (OpenCode Go): bounce 0/3, bypass 2/3, but every
// deepseek run read before editing, so its bypass never applied and the split is exploration. In
// the five bounces, the forced read never fixed the override: twice lfm read it and ignored it, and
// three reads were ranges around the entry that never reached it. Every pass found the override by
// its own grep or post-edit check, which both arms do. The bounce sends a model back to the region
// it is editing, the bytes an exact match already proves, so it does not guard this case.

const TARGET = 'src/routes.ts';
const OVERRIDE_MS = 1200;
const WANT_MS = 9000;

const ROUTES: [string, string, number, boolean][] = [
  ['/users', 'listUsers', 3000, true],
  ['/users/:id', 'getUser', 3000, true],
  ['/orders', 'listOrders', 5000, false],
  ['/orders/:id', 'getOrder', 5000, true],
  ['/invoices', 'listInvoices', 5000, false],
  ['/invoices/:id', 'getInvoice', 3000, true],
  ['/payments', 'listPayments', 8000, false],
  ['/payments/:id', 'getPayment', 8000, true],
  ['/refunds', 'listRefunds', 8000, false],
  ['/refunds/:id', 'getRefund', 8000, true],
  ['/customers', 'listCustomers', 3000, true],
  ['/customers/:id', 'getCustomer', 3000, true],
  ['/products', 'listProducts', 2000, true],
  ['/products/:id', 'getProduct', 2000, true],
  ['/carts', 'listCarts', 2000, true],
  ['/carts/:id', 'getCart', 2000, true],
  ['/shipments', 'listShipments', 6000, false],
  ['/shipments/:id', 'getShipment', 6000, true],
  ['/reports', 'listReports', 12000, false],
  ['/reports/:id', 'getReport', 12000, true],
  ['/webhooks', 'listWebhooks', 4000, false],
  ['/webhooks/:id', 'getWebhook', 4000, true],
  ['/sessions', 'listSessions', 1000, true],
  ['/sessions/:id', 'getSession', 1000, true],
];

export const ROUTES_SOURCE = [
  "import type { Route } from './types.js';",
  "import * as h from './handlers.js';",
  '',
  'export const routes: Route[] = [',
  ...ROUTES.flatMap(([path, handler, timeoutMs, retries]) => [
    '  {',
    `    path: '${path}',`,
    `    handler: h.${handler},`,
    `    timeoutMs: ${timeoutMs},`,
    `    retries: ${retries},`,
    '  },',
  ]),
  '];',
  '',
].join('\n');

export const OVERRIDES_BLOCK = [
  '',
  '// Synced from the ops config. An entry here wins over the table above at runtime.',
  'export const overrides: Record<string, Partial<Route>> = {',
  `  '/orders': { timeoutMs: ${OVERRIDE_MS} },`,
  '};',
  '',
].join('\n');

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

function ordersEntry(text: string): string | null {
  const at = text.indexOf("path: '/orders',");
  if (at === -1) return null;
  const end = text.indexOf('},', at);
  return end === -1 ? null : text.slice(at, end);
}

// The value that applies at runtime: an overrides entry beats the table, which is the trap.
export function effectiveOrders(text: string): {
  synced: boolean;
  timeoutMs: number | null;
  retries: boolean;
} {
  const entry = ordersEntry(text) ?? '';
  const table = /timeoutMs:\s*(\d+)/.exec(entry);
  const at = text.indexOf('overrides');
  const override =
    at === -1 ? null : /'\/orders':\s*\{[^}]*timeoutMs:\s*(\d+)/.exec(text.slice(at));
  const value = override?.[1] ?? table?.[1];
  return {
    synced: at !== -1,
    timeoutMs: value === undefined ? null : Number(value),
    retries: /retries:\s*true/.test(entry),
  };
}

export type RunReport = { rereadInTurnTwo: boolean; edits: string[] };

// Provider ids repeat across rounds on some engines (`call_0`), so a result is matched only against
// the assistant message of its own round. Turn two starts at the second non-harness user message.
export function reportRun(messages: Message[]): RunReport {
  const report: RunReport = { rereadInTurnTwo: false, edits: [] };
  let turn = 0;
  let round = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const m of messages) {
    if (m.role === 'user' && !m.harness) turn++;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      round = new Map(m.toolCalls.map(c => [c.id, c]));
    }
    if (m.role !== 'tool' || turn < 2) continue;
    const call = round.get(m.callId);
    if (!call) continue;
    const command = String(call.args.command ?? '');
    if (
      (call.name === 'read' && String(call.args.path ?? '').endsWith(TARGET)) ||
      (call.name === 'bash' && command.includes('routes.ts'))
    ) {
      // Only a look before the first landed edit could have shaped it.
      if (!report.edits.includes('landed')) report.rereadInTurnTwo = true;
    }
    if (call.name === 'edit' && String(call.args.path ?? '').endsWith(TARGET)) {
      const landed = /^Edited\b/.test(m.summary);
      report.edits.push(
        m.summary.startsWith('edit paused') ? 'bounced' : landed ? 'landed' : 'failed',
      );
    }
  }
  return report;
}

export function gradeRun(text: string, report: RunReport): AssertResult {
  const note = `read before the edit: ${report.rereadInTurnTwo ? 'yes' : 'no'}; edits: ${report.edits.join(', ') || 'none'}`;
  const orders = effectiveOrders(text);
  if (!orders.synced) return { pass: false, reason: `override block missing; ${note}` };
  if (!orders.retries) return { pass: false, reason: `/orders retries not enabled; ${note}` };
  if (orders.timeoutMs === OVERRIDE_MS) {
    return { pass: false, reason: `override left in force, walked past it; ${note}` };
  }
  if (orders.timeoutMs !== WANT_MS) {
    return { pass: false, reason: `/orders ends at ${orders.timeoutMs}ms; ${note}` };
  }
  return { pass: true, note };
}

export const fixture: Fixture = {
  name: 'read-first-exact',
  setup: SETUP,
  prompt:
    'Read src/routes.ts and quote the `/orders` entry (not `/orders/:id`) exactly as it appears, indentation included. Do not change anything yet.',
  followUp: 'Now make `/orders` time out after 9000 ms and retry at runtime.',
  beforeFollowUp: cwd => appendFile(join(cwd, TARGET), OVERRIDES_BLOCK, 'utf8'),
  timeoutMs: 15 * 60 * 1000,
  assert: async ({ cwd, messages }) =>
    gradeRun(await readFile(join(cwd, TARGET), 'utf8'), reportRun(messages)),
};
