import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config, Message, Tool } from '../types.js';
import { debugLog } from '../debug.js';
import { callModel } from './client.js';
import { latchesFor } from './latches.js';
import { chatTemplateKwargsFor, isLocalEngine } from './templatekwargs.js';

// Under prefix-stable the per-round note is a trailing user message, and a thinking template that
// ignores `preserve_thinking` (mlx-vlm, Ollama, a template with no switch) drops every earlier
// <think> behind it: on T2, lfm2.5-24b restated in 67% of rounds after the shed and made no edits,
// against ~10% with the note on the tool result (#827). This decides, per endpoint, which slot the
// note takes. Four tiny requests compare the engine's own prompt-token counts with and without a
// reasoning block, before and behind a user note: a template renders deterministically, so the
// counts either move by the reasoning's size or they don't. The live check in
// agent/noteslotmonitor.ts backs it up where the probe can't answer.

export type NoteSlotVerdict = 'hides' | 'renders' | 'never-renders';

export const NOTE_SLOT_CACHE_PATH = join(homedir(), '.config', 'reika', 'note-slot.json');
// A template is part of the model file, so a verdict outlives sessions; a week bounds how long a
// swapped template or engine upgrade can go unnoticed.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A probe the server never answered (still loading, down) is asked again at the next submit; a
// request it rejects outright would be rejected every time, so the attempts are bounded.
const MAX_ATTEMPTS = 3;
// Waiting on a model load is the one slow case, and the first real request would wait for it too.
const PROBE_TIMEOUT_MS = 120_000;

const SENTINEL_REASONING = [
  'Checking the parser first: the tokenizer splits on whitespace, then the lexer groups runs of',
  'digits into numbers and letters into identifiers. A quoted string keeps its spaces, so the',
  'splitter must skip quotes. Escapes inside quotes need a lookahead. The tests cover nested',
  'quotes but not an escape at the end of input, which is the likely crash.',
].join(' ');

const PROBE_TOOL: Tool = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async () => ({ summary: '' }),
};

type CacheEntry = { verdict: NoteSlotVerdict; at: number };

// The verdict is a fact about the template AND whether `preserve_thinking` reaches it, so the key
// carries both: a run with the kwarg withheld (REIKA_PRESERVE_THINKING=0, or an engine that 400'd it
// and latched it off) correctly finds `hides`, and the same model with the kwarg on must not read
// that back and move its note for a week.
function endpointKey(config: Pick<Config, 'baseURL' | 'model'>): string {
  const kwargs =
    chatTemplateKwargsFor(config.baseURL) !== undefined && !latchesFor(config).chatTemplateKwargs;
  return `${config.baseURL.replace(/\/+$/, '')}\n${config.model}\n${kwargs ? 'kwargs' : 'no-kwargs'}`;
}

function readCache(path: string): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeCache(path: string, key: string, verdict: NoteSlotVerdict): void {
  try {
    const all = readCache(path);
    all[key] = { verdict, at: Date.now() };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, path);
  } catch {
    // Fail-open: an unwritable cache only means the next session probes again.
  }
}

export function cachedNoteSlotVerdict(
  config: Pick<Config, 'baseURL' | 'model'>,
  path = NOTE_SLOT_CACHE_PATH,
  now = Date.now(),
): NoteSlotVerdict | undefined {
  const entry = readCache(path)[endpointKey(config)];
  if (!entry || now - entry.at > CACHE_TTL_MS) return undefined;
  return entry.verdict === 'hides' ||
    entry.verdict === 'renders' ||
    entry.verdict === 'never-renders'
    ? entry.verdict
    : undefined;
}

// Applies a verdict to the endpoint's latch. One-way: a session that moved its note to the tool
// result never moves it back, since each move re-renders earlier reasoning and costs a re-prefill.
export function applyNoteSlotVerdict(
  config: Pick<Config, 'baseURL' | 'model'>,
  verdict: NoteSlotVerdict,
  path = NOTE_SLOT_CACHE_PATH,
): void {
  if (verdict === 'hides') latchesFor(config).noteOnToolResult = true;
  writeCache(path, endpointKey(config), verdict);
}

// Equal counts within the few tokens an empty <think></think> pair can add mean the reasoning was
// dropped; a difference of at least half the reasoning's size means it rendered. Anything between
// is not a verdict.
export function classifyProbe(
  counts: { bare: number; withReasoning: number; noteBare: number; noteWithReasoning: number },
  reasoningTokens: number,
): NoteSlotVerdict | undefined {
  const rendered = (d: number) => d >= reasoningTokens * 0.5;
  const dropped = (d: number) => Math.abs(d) <= Math.max(4, reasoningTokens * 0.15);
  const beforeNote = counts.withReasoning - counts.bare;
  const behindNote = counts.noteWithReasoning - counts.noteBare;
  if (dropped(beforeNote)) return 'never-renders';
  if (!rendered(beforeNote)) return undefined;
  if (dropped(behindNote)) return 'hides';
  if (rendered(behindNote)) return 'renders';
  return undefined;
}

function probeHistory(reasoning: boolean): Message[] {
  return [
    { role: 'user', content: 'Find the crash in the parser.' },
    {
      role: 'assistant',
      content: '',
      ...(reasoning ? { reasoning: SENTINEL_REASONING } : {}),
      toolCalls: [{ id: 'probe1', name: 'read', args: { path: 'src/parser.ts' } }],
    },
    { role: 'tool', callId: 'probe1', summary: 'Read src/parser.ts', payload: 'export {};' },
  ];
}

// One request per variant, each with a fresh nonce at the head of the system prompt: an engine that
// reports only the tokens it evaluated (Ollama counts past its prefix cache) would otherwise read a
// shared prefix as a shorter prompt.
async function countPromptTokens(
  config: Config,
  reasoning: boolean,
  note: boolean,
  signal: AbortSignal,
): Promise<number | undefined> {
  const res = await callModel({
    system: `probe ${randomBytes(4).toString('hex')}`,
    history: probeHistory(reasoning),
    tools: [PROBE_TOOL],
    config,
    maxTokens: 1,
    prefixStable: true,
    trailingNote: note ? '(auto-generated status note — not user input)' : undefined,
    stampRenders: false,
    signal,
  });
  return res.usage?.promptTokens;
}

type ProbeOutcome = { reached: true; verdict?: NoteSlotVerdict } | { reached: false };

export async function probeNoteSlot(
  config: Config,
  controller = new AbortController(),
): Promise<ProbeOutcome> {
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Sequential on purpose: a single-slot server serves them one at a time anyway.
    const bare = await countPromptTokens(config, false, false, controller.signal);
    const withReasoning = await countPromptTokens(config, true, false, controller.signal);
    const noteBare = await countPromptTokens(config, false, true, controller.signal);
    const noteWithReasoning = await countPromptTokens(config, true, true, controller.signal);
    if (controller.signal.aborted) return { reached: false };
    if ([bare, withReasoning, noteBare, noteWithReasoning].some(n => n === undefined)) {
      debugLog('[reika:debug] note-slot probe verdict=? reason=no-usage\n');
      return { reached: true };
    }
    const counts = {
      bare: bare as number,
      withReasoning: withReasoning as number,
      noteBare: noteBare as number,
      noteWithReasoning: noteWithReasoning as number,
    };
    const verdict = classifyProbe(counts, Math.round(SENTINEL_REASONING.length / 4));
    debugLog(
      `[reika:debug] note-slot probe verdict=${verdict ?? '?'} bare=${counts.bare} ` +
        `reasoning=${counts.withReasoning} note=${counts.noteBare} noteReasoning=${counts.noteWithReasoning}\n`,
    );
    return { reached: true, verdict };
  } catch (e) {
    debugLog(`[reika:debug] note-slot probe unreached err=${e instanceof Error ? e.message : e}\n`);
    return { reached: false };
  } finally {
    clearTimeout(timer);
  }
}

type ProbeState = {
  attempts: number;
  inflight?: Promise<void>;
  controller?: AbortController;
  userAborted?: boolean;
  done: boolean;
};
const probeStates = new Map<string, ProbeState>();

// Settles which slot this endpoint's note takes before a turn starts. Idempotent and safe to call
// at every submit: a decided endpoint returns at once, a probe in flight is shared, and a server
// that was not up is asked again. Never between rounds — on a single-slot server a probe there
// would evict the conversation's cache. Only local engines: hosted APIs get no `preserve_thinking`
// to fail and no `prompt_tokens` worth comparing. REIKA_NOTE_SLOT forces the slot, so no probe.
// `signal` is the turn's: ctrl-c ends the wait at once and stops the probe rather than holding the
// turn until the probe's timeout on a hung server, and the probe is asked again at the next submit.
export function ensureNoteSlot(
  config: Config,
  path = NOTE_SLOT_CACHE_PATH,
  signal?: AbortSignal,
): Promise<void> {
  const settled = settleNoteSlot(config, path);
  if (!signal || !probeStates.get(endpointKey(config))?.inflight) return settled;
  if (signal.aborted) {
    stopProbe(config);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const onAbort = () => {
      stopProbe(config);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void settled.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function stopProbe(config: Config): void {
  const state = probeStates.get(endpointKey(config));
  if (!state?.controller) return;
  state.userAborted = true;
  state.controller.abort();
}

function settleNoteSlot(config: Config, path: string): Promise<void> {
  if (!config.noteSlotProbe || !isLocalEngine(config.baseURL)) return Promise.resolve();
  if (process.env.REIKA_NOTE_SLOT || process.env.REIKA_PREFIX_STABLE === '0') {
    return Promise.resolve();
  }
  const key = endpointKey(config);
  const state = probeStates.get(key) ?? { attempts: 0, done: false };
  probeStates.set(key, state);
  if (state.done || latchesFor(config).noteOnToolResult) return Promise.resolve();
  if (state.inflight) return state.inflight;
  const cached = cachedNoteSlotVerdict(config, path);
  if (cached) {
    if (cached === 'hides') latchesFor(config).noteOnToolResult = true;
    state.done = true;
    debugLog(`[reika:debug] note-slot cached verdict=${cached}\n`);
    return Promise.resolve();
  }
  if (state.attempts >= MAX_ATTEMPTS) return Promise.resolve();
  state.attempts++;
  state.controller = new AbortController();
  state.userAborted = false;
  state.inflight = probeNoteSlot(config, state.controller)
    .then(outcome => {
      if (!outcome.reached) {
        // A probe the user cut short says nothing about the server, so it costs no attempt.
        if (state.userAborted) state.attempts--;
        return;
      }
      state.done = true;
      if (outcome.verdict) applyNoteSlotVerdict(config, outcome.verdict, path);
    })
    .finally(() => {
      state.inflight = undefined;
      state.controller = undefined;
    });
  return state.inflight;
}

// Tests only.
export function resetNoteSlotProbes(): void {
  probeStates.clear();
}
