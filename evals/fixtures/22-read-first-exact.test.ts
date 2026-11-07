import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import {
  OVERRIDES_BLOCK,
  ROUTES_SOURCE,
  effectiveOrders,
  gradeRun,
  reportRun,
} from './22-read-first-exact.js';

const SYNCED = ROUTES_SOURCE + OVERRIDES_BLOCK;
const CHANGED = SYNCED.replace(
  "path: '/orders',\n    handler: h.listOrders,\n    timeoutMs: 5000,\n    retries: false,",
  "path: '/orders',\n    handler: h.listOrders,\n    timeoutMs: 9000,\n    retries: true,",
);
const REPORT = { rereadInTurnTwo: false, edits: ['landed'] };

const call = (id: string, name: string, args: Record<string, unknown>): Message => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, args }],
});
const result = (id: string, summary: string): Message => ({ role: 'tool', callId: id, summary });

describe('the file is over the aged floor', () => {
  it('keeps the read out of context once it ages', () => {
    expect(ROUTES_SOURCE.length).toBeGreaterThan(2048);
  });
});

describe('effectiveOrders', () => {
  it('reads the table before the sync', () => {
    expect(effectiveOrders(ROUTES_SOURCE)).toEqual({
      synced: false,
      timeoutMs: 5000,
      retries: false,
    });
  });

  it('lets the override win over the table', () => {
    expect(effectiveOrders(CHANGED).timeoutMs).toBe(1200);
  });

  it('falls back to the table when the override entry is gone', () => {
    const removed = CHANGED.replace("  '/orders': { timeoutMs: 1200 },\n", '');
    expect(effectiveOrders(removed).timeoutMs).toBe(9000);
  });
});

describe('gradeRun', () => {
  it('names a run that edited the table and walked past the override', () => {
    const r = gradeRun(CHANGED, REPORT);
    expect(r).toMatchObject({ pass: false });
    if (!r.pass) expect(r.reason).toContain('walked past');
  });

  it('passes a run that updated the override', () => {
    const fixed = CHANGED.replace('{ timeoutMs: 1200 }', '{ timeoutMs: 9000 }');
    expect(gradeRun(fixed, REPORT)).toMatchObject({ pass: true });
  });

  it('fails a run whose override block is gone', () => {
    const r = gradeRun(ROUTES_SOURCE, REPORT);
    if (!r.pass) expect(r.reason).toContain('override block missing');
    expect(r.pass).toBe(false);
  });
});

const user = (content: string): Message => ({ role: 'user', content });

describe('reportRun', () => {
  it('counts only turn two, and only a look before the first landed edit', () => {
    const report = reportRun([
      user('quote it'),
      call('c', 'read', { path: 'src/routes.ts' }),
      result('c', 'Read src/routes.ts'),
      user('now change it'),
      call('c', 'edit', { path: 'src/routes.ts' }),
      result('c', 'edit paused — read src/routes.ts first, then re-issue the edit'),
      call('c', 'read', { path: 'src/routes.ts' }),
      result('c', 'Read src/routes.ts'),
      call('c', 'edit', { path: 'src/routes.ts' }),
      result('c', 'Edited src/routes.ts at line 8 (+2 -2)'),
    ]);
    expect(report).toEqual({ rereadInTurnTwo: true, edits: ['bounced', 'landed'] });
  });

  it('does not count a read after the edit landed', () => {
    const report = reportRun([
      user('quote it'),
      user('now change it'),
      call('c', 'edit', { path: 'src/routes.ts' }),
      result('c', 'Edited src/routes.ts at line 8 (+2 -2)'),
      call('c', 'read', { path: 'src/routes.ts' }),
      result('c', 'Read src/routes.ts'),
    ]);
    expect(report).toEqual({ rereadInTurnTwo: false, edits: ['landed'] });
  });
});
