import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { PENDING_ROW_DELAY_MS, usePendingRow } from './pendingrow.js';

// The live in-flight row's paint delay (#951). A call that returns inside the delay must paint
// nothing at all — that intermediate frame is the flicker — and a call that outlives it must draw
// the row exactly as #509 had it, starting a moment later.

const plain = (s: string | undefined) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

// The hook as App uses it: fed the call in flight, drawing the row it hands back.
function Row({ tool, call = 1, force = false }: { tool: string; call?: number; force?: boolean }) {
  const shown = usePendingRow(tool, call, force);
  return <Text>{shown ? `↳ ${shown}` : '-'}</Text>;
}

const frameOf = (app: { lastFrame: () => string | undefined }) => plain(app.lastFrame()).trim();

describe('usePendingRow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('paints nothing for a call that ends inside the delay', async () => {
    const app = render(<Row tool="read" />);
    await vi.advanceTimersByTimeAsync(PENDING_ROW_DELAY_MS - 20);
    expect(frameOf(app)).toBe('-');
    // The result committed: the call is over before its row was ever due.
    app.rerender(<Row tool="" />);
    await vi.advanceTimersByTimeAsync(PENDING_ROW_DELAY_MS + 100);
    expect(frameOf(app)).toBe('-');
    app.unmount();
  });

  it('paints the row once the call has outlived the delay', async () => {
    const app = render(<Row tool="bash" />);
    await vi.advanceTimersByTimeAsync(PENDING_ROW_DELAY_MS - 1);
    expect(frameOf(app)).toBe('-');
    await vi.advanceTimersByTimeAsync(1);
    expect(frameOf(app)).toBe('↳ bash');
    app.unmount();
  });

  it('takes the row down the moment the result commits, rather than a delay later', async () => {
    const app = render(<Row tool="bash" />);
    await vi.advanceTimersByTimeAsync(PENDING_ROW_DELAY_MS);
    expect(frameOf(app)).toBe('↳ bash');
    app.rerender(<Row tool="" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(frameOf(app)).toBe('-');
    app.unmount();
  });

  it('gives the next call its own delay, even for the same tool', async () => {
    // A loop reading file after file announces `read` again in the same commit its result lands, so
    // the name never changes; the second call must not inherit the first's due flag.
    const app = render(<Row tool="read" call={1} />);
    await vi.advanceTimersByTimeAsync(PENDING_ROW_DELAY_MS);
    expect(frameOf(app)).toBe('↳ read');
    app.rerender(<Row tool="read" call={2} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(frameOf(app)).toBe('-');
    await vi.advanceTimersByTimeAsync(PENDING_ROW_DELAY_MS);
    expect(frameOf(app)).toBe('↳ read');

    app.rerender(<Row tool="edit" call={3} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(frameOf(app)).toBe('-');
    app.rerender(<Row tool="" call={3} />);
    app.rerender(<Row tool="edit" call={4} />);
    await vi.advanceTimersByTimeAsync(PENDING_ROW_DELAY_MS - 1);
    expect(frameOf(app)).toBe('-');
    app.unmount();
  });

  it('puts the row up at once when an answer forces it, and takes it down with the call', async () => {
    // #897: the frame an answered approval lands in collapses the dialog into this row, so it is
    // not allowed to wait out the delay — and the force must not outlive the call either.
    const app = render(<Row tool="bash" force />);
    await vi.advanceTimersByTimeAsync(0);
    expect(frameOf(app)).toBe('↳ bash');
    app.rerender(<Row tool="" force />);
    await vi.advanceTimersByTimeAsync(0);
    expect(frameOf(app)).toBe('-');
    app.unmount();
  });
});
