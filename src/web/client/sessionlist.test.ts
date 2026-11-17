import { describe, expect, it } from 'vitest';
import type { WireSessionEntry, WireSessionList } from '../protocol.js';
import { filterPlaceholder, listNote, savedAgo, sessionMeta, sessionTitle } from './sessionlist.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
const entry = (over: Partial<WireSessionEntry> = {}): WireSessionEntry => ({
  id: 'a.jsonl',
  savedAt: at(7200),
  messageCount: 13,
  ...over,
});
const list = (over: Partial<WireSessionList> = {}): WireSessionList => ({
  scope: 'project',
  entries: [],
  total: 0,
  autosave: true,
  ...over,
});

describe('savedAgo', () => {
  it.each([
    [5, 'just now'],
    [59, 'just now'],
    [60, '1 min ago'],
    [3599, '59 min ago'],
    [3600, '1h ago'],
    [86_399, '23h ago'],
    [86_400, '1d ago'],
    [6 * 86_400, '6d ago'],
    [8 * 86_400, '2026-11-07'],
  ])('%is ago reads %s', (s, text) => {
    expect(savedAgo(at(s), now)).toBe(text);
  });

  it('reads a time ahead of the clock as just now, and a bad date as nothing', () => {
    expect(savedAgo(at(-30), now)).toBe('just now');
    expect(savedAgo('soon', now)).toBe('');
  });
});

describe('sessionMeta', () => {
  it('joins age, count and model, leaving out what is absent', () => {
    expect(sessionMeta(entry({ model: 'qwen' }), now)).toBe('2h ago · 13 msgs · qwen');
    expect(sessionMeta(entry({ messageCount: 1 }), now)).toBe('2h ago · 1 msg');
  });
});

describe('sessionTitle', () => {
  it('names an untitled or blank session', () => {
    expect(sessionTitle(entry())).toBe('untitled');
    expect(sessionTitle(entry({ title: '  ' }))).toBe('untitled');
    expect(sessionTitle(entry({ title: 'fix it' }))).toBe('fix it');
  });
});

describe('listNote', () => {
  it('says why a list is empty', () => {
    expect(listNote(list(), '')).toBe('No saved sessions for this project yet.');
    expect(listNote(list({ autosave: false }), '')).toMatch(/REIKA_AUTOSAVE=0/);
    expect(listNote(list({ scope: 'root', autosave: false }), '')).toBe(
      'No /save transcripts yet.',
    );
    expect(listNote(list({ autosave: false }), 'x')).toBe('No sessions match.');
  });

  it('says nothing under a list with rows', () => {
    expect(listNote(list({ entries: [entry()], total: 250 }), '')).toBeNull();
  });
});

describe('filterPlaceholder', () => {
  it('names the total of a capped list, and no count when it is whole', () => {
    expect(filterPlaceholder(null)).toBe('Filter sessions');
    expect(filterPlaceholder(list({ entries: [entry()], total: 1 }))).toBe('Filter sessions');
    expect(filterPlaceholder(list({ entries: [entry()], total: 250 }))).toBe(
      'Filter all 250 sessions',
    );
  });
});
