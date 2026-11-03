import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../store/sessions.js';
import { ResumeSelect } from './ResumeSelect.js';

const entries: SessionEntry[] = Array.from({ length: 200 }, (_, i) => ({
  path: `/repo/s${i}.jsonl`,
  title: `session ${i}`,
  savedAt: new Date(2026, 8, 1 + (i % 28), i % 24, i % 60).toISOString(),
  messageCount: i,
}));

describe('ResumeSelect', () => {
  afterEach(() => vi.restoreAllMocks());

  // A project collects hundreds of sessions, and formatting every stamp on every arrow key was
  // the picker's whole cost — the stamps are formatted once per list.
  it('formats the list once, not on every cursor move', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleString');
    const { rerender } = render(<ResumeSelect entries={entries} selectedIndex={0} heading="x" />);
    const afterMount = spy.mock.calls.length;
    for (let sel = 1; sel <= 20; sel++) {
      rerender(<ResumeSelect entries={entries} selectedIndex={sel} heading="x" />);
    }
    expect(afterMount).toBe(entries.length);
    expect(spy.mock.calls.length).toBe(afterMount);
  });

  it('keeps the stamp column one width as the window scrolls', () => {
    const { lastFrame, rerender } = render(
      <ResumeSelect entries={entries} selectedIndex={0} heading="x" />,
    );
    const titleColumn = (frame: string) =>
      frame
        .split('\n')
        .filter(l => l.includes('session '))
        .map(l => l.indexOf('session '));
    const first = titleColumn(lastFrame() ?? '');
    rerender(<ResumeSelect entries={entries} selectedIndex={150} heading="x" />);
    const later = titleColumn(lastFrame() ?? '');
    expect(new Set([...first, ...later]).size).toBe(1);
  });
});
