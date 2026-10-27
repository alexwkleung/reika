import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { latchesFor, resetEndpointLatches } from '../provider/latches.js';
import { cachedNoteSlotVerdict } from '../provider/noteslot.js';
import {
  observeNoteSlot,
  reasoningCharsBehindNote,
  resetNoteSlotMonitor,
} from './noteslotmonitor.js';

const config = { baseURL: 'http://127.0.0.1:8080/v1', model: 'lfm' };
const cachePath = () => join(mkdtempSync(join(tmpdir(), 'reika-noteslotmon-')), 'note-slot.json');

describe('observeNoteSlot', () => {
  beforeEach(() => {
    resetNoteSlotMonitor();
    resetEndpointLatches();
  });

  const baseline = (path: string) => {
    for (const promptTokens of [1100, 1140, 1120]) {
      observeNoteSlot({
        config,
        promptTokens,
        estimate: 1000,
        noteSent: false,
        reasoningChars: 0,
        cachePath: path,
      });
    }
  };
  // A note round with 1200 chars (300 tokens) of reasoning behind it, on a 1000-token estimate.
  const noteRound = (promptTokens: number, path: string) =>
    observeNoteSlot({
      config,
      promptTokens,
      estimate: 1000,
      noteSent: true,
      reasoningChars: 1200,
      cachePath: path,
    });

  it('switches after two rounds whose count is missing the reasoning', () => {
    const path = cachePath();
    baseline(path);
    // Baseline density 1.12: rendered would be ~1120, dropped ~784.
    expect(noteRound(800, path)).toMatchObject({ kind: 'tested', hidden: true, switched: false });
    expect(latchesFor(config).noteOnToolResult).toBe(false);
    expect(noteRound(790, path)).toMatchObject({ kind: 'tested', hidden: true, switched: true });
    expect(latchesFor(config).noteOnToolResult).toBe(true);
    expect(cachedNoteSlotVerdict(config, path)).toBe('hides');
    expect(noteRound(790, path)).toEqual({ kind: 'skipped', reason: 'tool-slot' });
  });

  it('does not switch on the density drop a working setup shows after a shed', () => {
    const path = cachePath();
    baseline(path);
    // About 10% under baseline: aged payloads read as prose, the reasoning still rendered.
    for (let n = 0; n < 4; n++) {
      expect(noteRound(1010, path)).toMatchObject({ kind: 'tested', hidden: false });
    }
    expect(latchesFor(config).noteOnToolResult).toBe(false);
  });

  it('needs two hidden rounds in a row', () => {
    const path = cachePath();
    baseline(path);
    noteRound(800, path);
    noteRound(1100, path);
    expect(noteRound(800, path)).toMatchObject({ hidden: true, streak: 1, switched: false });
  });

  it('withholds a verdict without a baseline or with little reasoning behind the note', () => {
    const path = cachePath();
    expect(noteRound(800, path)).toEqual({ kind: 'skipped', reason: 'no-baseline' });
    baseline(path);
    expect(
      observeNoteSlot({
        config,
        promptTokens: 800,
        estimate: 1000,
        noteSent: true,
        reasoningChars: 400,
        cachePath: path,
      }),
    ).toEqual({ kind: 'skipped', reason: 'little-reasoning' });
  });
});

describe('reasoningCharsBehindNote', () => {
  it('counts the live reasoning after the newest user message', () => {
    const history: Message[] = [
      { role: 'assistant', content: '', reasoning: 'old turn' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', reasoning: 'abcd' },
      { role: 'tool', callId: 'a', summary: 's' },
      { role: 'assistant', content: '', reasoning: 'aged', reasoningAged: true },
      { role: 'assistant', content: '', reasoning: 'efgh' },
    ];
    expect(reasoningCharsBehindNote(history)).toBe(8);
  });
});
