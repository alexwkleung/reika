import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { latchesFor, resetEndpointLatches } from '../provider/latches.js';
import {
  observeNoteSlot,
  reasoningCharsBehindNote,
  resetNoteSlotMonitor,
} from './noteslotmonitor.js';

const config = { baseURL: 'http://127.0.0.1:8080/v1', model: 'lfm' };

describe('observeNoteSlot', () => {
  beforeEach(() => {
    resetNoteSlotMonitor();
    resetEndpointLatches();
  });

  const baseline = () => {
    for (const promptTokens of [1100, 1140, 1120]) {
      observeNoteSlot({
        config,
        promptTokens,
        estimate: 1000,
        noteSent: false,
        reasoningChars: 0,
      });
    }
  };
  // A note round with 1200 chars (300 tokens) of reasoning behind it, on a 1000-token estimate.
  const noteRound = (promptTokens: number) =>
    observeNoteSlot({
      config,
      promptTokens,
      estimate: 1000,
      noteSent: true,
      reasoningChars: 1200,
    });

  it('switches after two rounds whose count is missing the reasoning', () => {
    baseline();
    // Baseline density 1.12: rendered would be ~1120, dropped ~784.
    expect(noteRound(800)).toMatchObject({ kind: 'tested', hidden: true, switched: false });
    expect(latchesFor(config).noteOnToolResult).toBe(false);
    expect(noteRound(790)).toMatchObject({ kind: 'tested', hidden: true, switched: true });
    expect(latchesFor(config).noteOnToolResult).toBe(true);
    expect(noteRound(790)).toEqual({ kind: 'skipped', reason: 'tool-slot' });
  });

  it('does not switch on the density drop a working setup shows after a shed', () => {
    baseline();
    // About 10% under baseline: aged payloads read as prose, the reasoning still rendered.
    for (let n = 0; n < 4; n++) {
      expect(noteRound(1010)).toMatchObject({ kind: 'tested', hidden: false });
    }
    expect(latchesFor(config).noteOnToolResult).toBe(false);
  });

  it('needs two hidden rounds in a row', () => {
    baseline();
    noteRound(800);
    noteRound(1100);
    expect(noteRound(800)).toMatchObject({ hidden: true, streak: 1, switched: false });
  });

  it('withholds a verdict without a baseline or with little reasoning behind the note', () => {
    expect(noteRound(800)).toEqual({ kind: 'skipped', reason: 'no-baseline' });
    baseline();
    expect(
      observeNoteSlot({
        config,
        promptTokens: 800,
        estimate: 1000,
        noteSent: true,
        reasoningChars: 400,
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
