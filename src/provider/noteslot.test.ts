import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Message } from '../types.js';
import type { ModelResponse } from './client.js';

// A scripted engine whose template hides reasoning behind a trailing user note: the reported
// prompt-token count is the request's characters / 4, minus the reasoning when a user message
// follows it. `mode` switches it to a template that always renders, or never does.
const h = vi.hoisted(() => ({
  mode: 'hides' as 'hides' | 'renders' | 'never-renders' | 'no-usage' | 'down',
  calls: 0,
}));
vi.mock('./client.js', () => ({
  callModel: vi.fn(async (opts: { system: string; history: Message[]; trailingNote?: string }) => {
    h.calls++;
    if (h.mode === 'down') throw new Error('fetch failed');
    if (h.mode === 'no-usage') return { content: '' } as ModelResponse;
    let chars = opts.system.length + (opts.trailingNote?.length ?? 0);
    for (const m of opts.history) {
      chars += 'content' in m && typeof m.content === 'string' ? m.content.length : 0;
      if (m.role === 'tool') chars += (m.payload ?? m.summary).length;
      if (m.role === 'assistant' && m.reasoning) {
        const behindNote = !!opts.trailingNote;
        const shown =
          h.mode === 'renders' || (h.mode === 'hides' && !behindNote) ? m.reasoning.length : 0;
        chars += shown;
      }
    }
    return { content: '', usage: { promptTokens: Math.round(chars / 4), completionTokens: 1 } };
  }),
}));

const {
  applyNoteSlotVerdict,
  cachedNoteSlotVerdict,
  classifyProbe,
  ensureNoteSlot,
  resetNoteSlotProbes,
} = await import('./noteslot.js');
const { latchesFor, resetEndpointLatches } = await import('./latches.js');

const cachePath = () => join(mkdtempSync(join(tmpdir(), 'reika-noteslot-')), 'note-slot.json');
const local = {
  baseURL: 'http://127.0.0.1:8080/v1',
  model: 'lfm',
  noteSlotProbe: true,
} as Config;

describe('classifyProbe', () => {
  const R = 100;
  it('reads a count that moves before the note but not behind it as hides', () => {
    expect(
      classifyProbe({ bare: 50, withReasoning: 150, noteBare: 60, noteWithReasoning: 61 }, R),
    ).toBe('hides');
  });
  it('reads a count that moves in both places as renders', () => {
    expect(
      classifyProbe({ bare: 50, withReasoning: 150, noteBare: 60, noteWithReasoning: 158 }, R),
    ).toBe('renders');
  });
  it('reads a template that never shows past reasoning as never-renders', () => {
    expect(
      classifyProbe({ bare: 50, withReasoning: 52, noteBare: 60, noteWithReasoning: 62 }, R),
    ).toBe('never-renders');
  });
  it('gives no verdict on a difference between the two bands', () => {
    expect(
      classifyProbe({ bare: 50, withReasoning: 80, noteBare: 60, noteWithReasoning: 61 }, R),
    ).toBeUndefined();
    expect(
      classifyProbe({ bare: 50, withReasoning: 150, noteBare: 60, noteWithReasoning: 90 }, R),
    ).toBeUndefined();
  });
});

describe('note-slot cache', () => {
  it('round-trips a verdict and expires it after a week', () => {
    const path = cachePath();
    applyNoteSlotVerdict({ baseURL: 'http://a/v1', model: 'm' }, 'renders', path);
    expect(cachedNoteSlotVerdict({ baseURL: 'http://a/v1/', model: 'm' }, path)).toBe('renders');
    expect(cachedNoteSlotVerdict({ baseURL: 'http://a/v1', model: 'other' }, path)).toBeUndefined();
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(
      cachedNoteSlotVerdict({ baseURL: 'http://a/v1', model: 'm' }, path, later),
    ).toBeUndefined();
  });

  it('reads a corrupt file as empty', () => {
    const path = cachePath();
    writeFileSync(path, '{not json');
    expect(cachedNoteSlotVerdict({ baseURL: 'http://a/v1', model: 'm' }, path)).toBeUndefined();
  });
});

describe('ensureNoteSlot', () => {
  beforeEach(() => {
    h.calls = 0;
    h.mode = 'hides';
    resetNoteSlotProbes();
    resetEndpointLatches();
  });
  afterEach(() => {
    delete process.env.REIKA_NOTE_SLOT;
    delete process.env.REIKA_PREFIX_STABLE;
  });

  it('latches the tool slot and remembers it when the template hides reasoning', async () => {
    const path = cachePath();
    await ensureNoteSlot(local, path);
    expect(h.calls).toBe(4);
    expect(latchesFor(local).noteOnToolResult).toBe(true);
    expect(cachedNoteSlotVerdict(local, path)).toBe('hides');
    await ensureNoteSlot(local, path);
    expect(h.calls).toBe(4);
  });

  it('leaves the user slot on a template that renders reasoning behind the note', async () => {
    h.mode = 'renders';
    const path = cachePath();
    await ensureNoteSlot(local, path);
    expect(latchesFor(local).noteOnToolResult).toBe(false);
    expect(cachedNoteSlotVerdict(local, path)).toBe('renders');
  });

  it('leaves the user slot when the template never renders past reasoning', async () => {
    h.mode = 'never-renders';
    await ensureNoteSlot(local, cachePath());
    expect(latchesFor(local).noteOnToolResult).toBe(false);
  });

  it('starts from a cached verdict without probing', async () => {
    const path = cachePath();
    applyNoteSlotVerdict(local, 'hides', path);
    resetEndpointLatches();
    await ensureNoteSlot(local, path);
    expect(h.calls).toBe(0);
    expect(latchesFor(local).noteOnToolResult).toBe(true);
  });

  it('asks again at the next call when the server was not up, up to a bound', async () => {
    h.mode = 'down';
    const path = cachePath();
    await ensureNoteSlot(local, path);
    expect(h.calls).toBe(1);
    h.mode = 'hides';
    await ensureNoteSlot(local, path);
    expect(latchesFor(local).noteOnToolResult).toBe(true);

    resetNoteSlotProbes();
    resetEndpointLatches();
    h.mode = 'down';
    h.calls = 0;
    const other = { ...local, model: 'other' } as Config;
    for (let n = 0; n < 5; n++) await ensureNoteSlot(other, cachePath());
    expect(h.calls).toBe(3);
  });

  it('settles on no verdict when the engine reports no usage', async () => {
    h.mode = 'no-usage';
    const path = cachePath();
    await ensureNoteSlot(local, path);
    await ensureNoteSlot(local, path);
    expect(h.calls).toBe(4);
    expect(latchesFor(local).noteOnToolResult).toBe(false);
    expect(cachedNoteSlotVerdict(local, path)).toBeUndefined();
  });

  it('shares one probe between concurrent callers', async () => {
    const path = cachePath();
    await Promise.all([ensureNoteSlot(local, path), ensureNoteSlot(local, path)]);
    expect(h.calls).toBe(4);
  });

  it('sends nothing for a hand-built config, a hosted API, a forced slot or prefix-stable off', async () => {
    await ensureNoteSlot({ ...local, noteSlotProbe: undefined } as Config, cachePath());
    await ensureNoteSlot(
      { ...local, baseURL: 'https://api.example.com/v1' } as Config,
      cachePath(),
    );
    process.env.REIKA_NOTE_SLOT = 'user';
    await ensureNoteSlot(local, cachePath());
    delete process.env.REIKA_NOTE_SLOT;
    process.env.REIKA_PREFIX_STABLE = '0';
    await ensureNoteSlot(local, cachePath());
    expect(h.calls).toBe(0);
  });
});
