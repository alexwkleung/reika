import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import { ROUTES_SOURCE, reportEditCalls } from './19-edit-recall.js';

const edit = (id: string, old_string: string, new_string: string): Message => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name: 'edit', args: { path: 'src/routes.ts', old_string, new_string } }],
});
const result = (id: string, summary: string): Message => ({ role: 'tool', callId: id, summary });

const ORDERS_OLD = [
  "    path: '/orders',",
  '    handler: h.listOrders,',
  '    timeoutMs: 5000,',
].join('\n');

describe('reportEditCalls', () => {
  it('classifies an exact edit and replays it', () => {
    const r = reportEditCalls(
      [
        edit('a', ORDERS_OLD, ORDERS_OLD.replace('5000', '9000')),
        result('a', 'Edited src/routes.ts'),
        edit(
          'b',
          '    timeoutMs: 9000,\n    retries: false,',
          '    timeoutMs: 9000,\n    retries: true,',
        ),
        result('b', 'Edited src/routes.ts'),
      ],
      ROUTES_SOURCE,
    );
    expect(r.lost).toBe(false);
    expect(r.calls.map(c => c.kind)).toEqual(['exact', 'exact']);
  });

  it('marks a context-only slip rebase-eligible', () => {
    // Misremembered handler name in a context line the change does not touch.
    const old = ORDERS_OLD.replace('listOrders', 'getOrders');
    const r = reportEditCalls(
      [
        edit('a', old, old.replace('5000', '9000')),
        result('a', 'Edit failed: old_string not found'),
      ],
      ROUTES_SOURCE,
    );
    expect(r.calls[0].kind).toBe('diverged');
    expect(r.calls[0].misremembered).toEqual(['handler: h.getOrders,']);
    // new_string repeats the context line, so the slip is echoed — the case a rebase must refuse.
    expect(r.calls[0].echoed).toEqual(['handler: h.getOrders,']);
  });

  it('separates an echoed slip from one only in old_string', () => {
    const old = ORDERS_OLD.replace('listOrders', 'getOrders');
    const r = reportEditCalls(
      [
        edit('a', old, ORDERS_OLD.replace('5000', '9000')),
        result('a', 'Edit failed: old_string not found'),
      ],
      ROUTES_SOURCE,
    );
    expect(r.calls[0].misremembered).toHaveLength(1);
    expect(r.calls[0].echoed).toEqual([]);
  });

  it('records a read-first bounce', () => {
    const r = reportEditCalls(
      [edit('a', ORDERS_OLD, ORDERS_OLD), result('a', 'edit paused — read src/routes.ts first')],
      ROUTES_SOURCE,
    );
    expect(r.calls[0].bounced).toBe(true);
  });

  it('stops the replay after a non-exact apply', () => {
    const indented = ORDERS_OLD.replace(/^ {4}/gm, '  ');
    const r = reportEditCalls(
      [
        edit('a', indented, indented.replace('5000', '9000')),
        result('a', 'Edited src/routes.ts'),
        edit('b', 'x', 'y'),
        result('b', 'Edit failed'),
      ],
      ROUTES_SOURCE,
    );
    expect(r.calls.map(c => c.kind)).toEqual(['fuzzy']);
    expect(r.lost).toBe(true);
  });
});
