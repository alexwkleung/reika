import type { WireSessionEntry, WireSessionList } from '../protocol.js';

// The history drawer's words, kept apart from the component so they test without a DOM.

// Coarse on purpose: a list of sessions is read for "which one was that", not for the minute.
// Past a week the date itself, in ISO order, so it reads the same in every locale.
export function savedAgo(savedAt: string, now: number): string {
  const t = Date.parse(savedAt);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  // A one-letter unit sits against its number; `min` is a word and keeps its space.
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return savedAt.slice(0, 10);
}

export function sessionMeta(entry: WireSessionEntry, now: number): string {
  const msgs = `${entry.messageCount} ${entry.messageCount === 1 ? 'msg' : 'msgs'}`;
  return [savedAgo(entry.savedAt, now), msgs, entry.model].filter(Boolean).join(' · ');
}

export function sessionTitle(entry: WireSessionEntry): string {
  return entry.title?.trim() || 'untitled';
}

// What an empty list says. Null when it has rows.
export function listNote(list: WireSessionList, filter: string): string | null {
  if (list.entries.length === 0) {
    if (filter.trim()) return 'No sessions match.';
    if (list.scope === 'root') return 'No /save transcripts yet.';
    return list.autosave
      ? 'No saved sessions for this project yet.'
      : 'Auto-save is off (REIKA_AUTOSAVE=0), so nothing is listed.';
  }
  return null;
}

// A capped list names its total in the filter, the one control that reaches the sessions past it.
export function filterPlaceholder(list: WireSessionList | null): string {
  return list && list.total > list.entries.length
    ? `Filter all ${list.total} sessions`
    : 'Filter sessions';
}
