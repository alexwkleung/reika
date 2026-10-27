import type { Config, Message } from '../types.js';
import { latchesFor } from '../provider/latches.js';
import { applyNoteSlotVerdict } from '../provider/noteslot.js';
import { noteRidesToolResult } from '../provider/toolcall.js';

// The live backstop for the note-slot probe (#827). The probe can be wrong or silent: an engine
// that reports no usage, a real history its synthetic one doesn't match. So every round that sent a
// user-role note tests the engine's prompt-token count against the two things it could be: the
// estimate at the session's baseline density (the reasoning behind the note rendered) or that
// minus the reasoning (it was dropped). The baseline comes from rounds with no note, where nothing
// hides anything. Conservative on purpose, because content density also shifts after a shed
// (aged payloads become prose summaries; working setups measured about 10% lower): a round counts
// as hidden only when at least three quarters of the reasoning is missing and the reasoning is a
// quarter of the request, and two such rounds in a row switch the slot. One-way, like the probe.

const BASELINE_SAMPLES = 8;
const MIN_BASELINE = 2;
const MIN_REASONING_SHARE = 0.25;
const MISSING_SHARE = 0.75;
const HIDDEN_ROUNDS_TO_SWITCH = 2;

type MonitorState = { baseline: number[]; hiddenStreak: number };
const states = new Map<string, MonitorState>();

function stateFor(config: Pick<Config, 'baseURL' | 'model'>): MonitorState {
  const key = `${config.baseURL.replace(/\/+$/, '')}\n${config.model}`;
  let state = states.get(key);
  if (!state) {
    state = { baseline: [], hiddenStreak: 0 };
    states.set(key, state);
  }
  return state;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Characters of reasoning a request carries behind its trailing note: the assistant messages after
// the newest user-role message, which a template that hides reasoning drops once a note follows
// them. Reasoning batch aging already dropped is not sent at all.
export function reasoningCharsBehindNote(history: Message[]): number {
  let chars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.reasoning && !m.reasoningAged) chars += m.reasoning.length;
  }
  return chars;
}

export type NoteSlotObservation = {
  config: Pick<Config, 'baseURL' | 'model'>;
  promptTokens: number;
  // The char/4 estimate of the request just sent, the denominator calibration uses.
  estimate: number;
  noteSent: boolean;
  reasoningChars: number;
  // Where a switch is remembered for the next session; tests point it at a temp file.
  cachePath?: string;
};

export type NoteSlotCheck =
  | { kind: 'baseline'; factor: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'tested'; hidden: boolean; streak: number; switched: boolean };

export function observeNoteSlot(obs: NoteSlotObservation): NoteSlotCheck {
  const latches = latchesFor(obs.config);
  if (noteRidesToolResult(latches)) return { kind: 'skipped', reason: 'tool-slot' };
  if (process.env.REIKA_NOTE_SLOT === 'user') return { kind: 'skipped', reason: 'forced' };
  if (obs.estimate <= 0 || obs.promptTokens <= 0) return { kind: 'skipped', reason: 'no-count' };
  const state = stateFor(obs.config);
  const factor = obs.promptTokens / obs.estimate;
  if (!obs.noteSent) {
    state.baseline.push(factor);
    if (state.baseline.length > BASELINE_SAMPLES) state.baseline.shift();
    return { kind: 'baseline', factor };
  }
  if (state.baseline.length < MIN_BASELINE) return { kind: 'skipped', reason: 'no-baseline' };
  const reasoningTokens = obs.reasoningChars / 4;
  if (reasoningTokens < obs.estimate * MIN_REASONING_SHARE) {
    return { kind: 'skipped', reason: 'little-reasoning' };
  }
  const base = median(state.baseline);
  const missing = base * obs.estimate - obs.promptTokens;
  const hidden = missing >= base * reasoningTokens * MISSING_SHARE;
  state.hiddenStreak = hidden ? state.hiddenStreak + 1 : 0;
  const switched = state.hiddenStreak >= HIDDEN_ROUNDS_TO_SWITCH;
  if (switched) applyNoteSlotVerdict(obs.config, 'hides', obs.cachePath);
  return { kind: 'tested', hidden, streak: state.hiddenStreak, switched };
}

// Tests only.
export function resetNoteSlotMonitor(): void {
  states.clear();
}
