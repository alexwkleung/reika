import type { ShrinkCounts } from '../agent/loop.js';
import type { Controller, ControllerStatus, LiveTurn } from '../controller.js';
import type { SessionEntry } from '../store/sessions.js';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  AutoApproveMode,
  Message,
  Mode,
  QuestionAnswer,
  QuestionOption,
  QuestionRequest,
  Usage,
} from '../types.js';
import type { ConfirmSpec } from '../ui/dialogspecs.js';
import type { ModelTarget } from '../ui/models.js';
import { isPasteMarker, type PastedText } from '../ui/pastes.js';
import type { SuggestionState } from '../ui/suggest.js';
import type { Approvals } from '../ui/summary.js';

// The JSON a local server sends a browser tab and accepts back (#584/#595). Types only on the
// import side, but for the dependency-free paste marker check, so nothing here loads Ink, React or
// a server.

// 2: mode and model switches, pastes on submit, completions, input history, the model list (#584).
export const PROTOCOL_VERSION = 2;

// Spelled out rather than imported from the mode module; a test holds it to MODE_CYCLE.
export const WIRE_MODES = [
  'agent',
  'plan',
  'minimal',
  'vibe',
  'grind',
  'chat',
  'shell',
] as const satisfies readonly Mode[];

// Bounds on what a tab may send. A completion is asked per keystroke, and `@word` matching runs on
// the server's main thread; a tab past the cap sends only the trailing `@word`.
export const MAX_COMPLETE_CHARS = 2000;
export const MAX_SUBMIT_PASTES = 32;

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

// What no renderer draws: the model's copy of a tool result (up to 64KB each) and the aging marks.
// A key no Message has any more stops this compiling.
export const DROPPED_MESSAGE_KEYS = [
  'payload',
  'rendered',
  'payloadId',
  'aged',
  'reasoningAged',
  'continuationTail',
] as const satisfies readonly KeysOfUnion<Message>[];

type DroppedKey = (typeof DROPPED_MESSAGE_KEYS)[number];

// Distributive, so a field added to Message later is on the wire unless it joins DroppedKey.
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WireMessage = OmitEach<Message, DroppedKey>;

// A `compaction` message passes through as it is: it carries nothing heavy, and a scrollback
// never holds one, so dropping it here would hide a bug upstream rather than fix it.
export function wireMessage(msg: Message): WireMessage {
  const out: Record<string, unknown> = { ...msg };
  for (const key of DROPPED_MESSAGE_KEYS) delete out[key];
  return out as WireMessage;
}

// Null before the session has booted, rather than absent, so a client reads one shape always.
export type WireState = {
  mode: Mode;
  status: ControllerStatus;
  error: string | null;
  model: string | null;
  profile: string | null;
  cwd: string | null;
  autoApprove: AutoApproveMode;
  unattended: boolean;
  usage: Usage;
  lastUsage: Usage | null;
  estimatedContext: number | null;
  contextWindow: number | null;
  shrink: ShrinkCounts;
  // Null rather than undefined: JSON would drop the key.
  decodeRate: number | null;
  // A count of images, never their bytes or OCR text.
  queue: { content: string; images: number }[];
  approvals: Approvals;
  // A line is being prepared (its questions, a link fetch) or run: a mode or model switch waits.
  preparing: boolean;
  // What a submit is waiting on before its turn starts, e.g. "Fetching 1 pasted link".
  stage: string | null;
  modelPinned: boolean;
};

export function wireState(controller: Controller, stage: string | null = null): WireState {
  const snap = controller.getSnapshot();
  const session = controller.session;
  const cfg = session?.getSnapshot().config;
  // The fallback transcriptMeta uses, so the gauge and a saved header name the same window.
  const profile = session && cfg ? (cfg.profiles[session.profile] ?? cfg.profiles.default) : null;
  return {
    mode: snap.mode,
    status: snap.status,
    error: snap.error,
    model: profile?.model ?? null,
    profile: session?.profile ?? null,
    cwd: session?.bundle.cwd ?? null,
    autoApprove: controller.autoApprove,
    unattended: controller.unattended,
    usage: snap.usage,
    lastUsage: snap.lastUsage,
    estimatedContext: snap.estimatedContext,
    contextWindow: profile?.contextWindow ?? cfg?.contextWindow ?? null,
    shrink: snap.shrink,
    decodeRate: snap.decodeRate ?? null,
    queue: snap.queue.map(m => ({ content: m.content, images: m.images?.length ?? 0 })),
    approvals: snap.approvals,
    preparing: snap.preparing,
    stage,
    modelPinned: controller.modelPinned,
  };
}

// Deep, and blind to key order: a usage total gains `cachedTokens` by spread, so two equal
// states need not list their keys alike.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k =>
    sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function sameState(a: WireState, b: WireState): boolean {
  return sameJson(a, b);
}

export function sameCatalog(a: WireCatalog, b: WireCatalog): boolean {
  return sameJson(a, b);
}

// What the mode and model pills offer. `models` carries each target's base URL, as the model
// picker's dialog does.
export type WireCatalog = { models: ModelTarget[] };

export function wireCatalog(controller: Controller): WireCatalog {
  return { models: controller.modelTargets().map(t => ({ ...t })) };
}

// A completion list, or null for none. `partial` is the tail of the text an item replaces.
export type WireCompletion = SuggestionState | null;

export type WireDialog =
  | {
      kind: 'approval';
      tool: string;
      subject: string;
      preview: string;
      startLine?: number;
      warnings?: string[];
    }
  | { kind: 'question'; question: string; options: QuestionOption[] }
  | {
      kind: 'confirm';
      title: string;
      subtitle: string;
      details: string[];
      options: string[];
      accept?: string;
      initial: number;
    }
  | { kind: 'model'; targets: ModelTarget[] }
  | { kind: 'session'; heading: string; entries: SessionEntry[] };

export function approvalDialog(request: ApprovalRequest): WireDialog {
  return {
    kind: 'approval',
    tool: request.tool,
    subject: request.subject,
    preview: request.preview,
    ...(request.startLine !== undefined ? { startLine: request.startLine } : {}),
    ...(request.warnings !== undefined ? { warnings: [...request.warnings] } : {}),
  };
}

export function questionDialog(request: QuestionRequest): WireDialog {
  return {
    kind: 'question',
    question: request.question,
    options: request.options.map(o => ({ ...o })),
  };
}

export function confirmDialog(spec: ConfirmSpec, initial = 0): WireDialog {
  return {
    kind: 'confirm',
    title: spec.title,
    subtitle: spec.subtitle,
    details: [...spec.details],
    options: [...spec.options],
    ...(spec.accept !== undefined ? { accept: spec.accept } : {}),
    initial,
  };
}

export function modelDialog(targets: ModelTarget[]): WireDialog {
  return { kind: 'model', targets: targets.map(t => ({ ...t })) };
}

export function sessionDialog(list: { heading: string; entries: SessionEntry[] }): WireDialog {
  return { kind: 'session', heading: list.heading, entries: list.entries.map(e => ({ ...e })) };
}

// The in-flight turn, sent whole on each change rather than patched: a tab that missed one
// update is right again at the next. The controller holds it and applies its rules.
export type WireLive = LiveTurn;

// Committed events are numbered and replayed to a tab that reconnects; live ones are not.
export type CommittedEvent =
  | { type: 'hello'; seq: number; version: number }
  | { type: 'message'; seq: number; message: WireMessage }
  | { type: 'reset'; seq: number; messages: WireMessage[] }
  | { type: 'state'; seq: number; state: WireState }
  | { type: 'dialog'; seq: number; id: string; dialog: WireDialog }
  | { type: 'resolved'; seq: number; id: string; outcome: 'answered' | 'cancelled' }
  | { type: 'catalog'; seq: number; catalog: WireCatalog }
  // The whole input history, replacing what a tab holds; `historyAdd` appends one line.
  | { type: 'history'; seq: number; entries: string[] }
  | { type: 'historyAdd'; seq: number; entry: string };

// `now` is the server's clock when the event was sent. `live.pending.since` is on that clock too,
// so a tab times a running call from the pair and never from its own clock against the server's.
export type LiveEvent =
  | { type: 'live'; live: WireLive; now: number }
  | { type: 'delta'; channel: 'content' | 'reasoning' | 'tool'; text: string };

export type ServerEvent = CommittedEvent | LiveEvent;

export function helloEvent(seq: number): CommittedEvent {
  return { type: 'hello', seq, version: PROTOCOL_VERSION };
}

export function liveEvent(live: WireLive, now: number): LiveEvent {
  return { type: 'live', live, now };
}

export function messageEvent(seq: number, message: Message): CommittedEvent {
  return { type: 'message', seq, message: wireMessage(message) };
}

export function resetEvent(seq: number, messages: Message[]): CommittedEvent {
  return { type: 'reset', seq, messages: messages.map(wireMessage) };
}

export function stateEvent(seq: number, state: WireState): CommittedEvent {
  return { type: 'state', seq, state };
}

export function catalogEvent(seq: number, catalog: WireCatalog): CommittedEvent {
  return { type: 'catalog', seq, catalog };
}

export function historyEvent(seq: number, entries: string[]): CommittedEvent {
  return { type: 'history', seq, entries: [...entries] };
}

export function historyAddEvent(seq: number, entry: string): CommittedEvent {
  return { type: 'historyAdd', seq, entry };
}

export function dialogEvent(seq: number, id: string, dialog: WireDialog): CommittedEvent {
  return { type: 'dialog', seq, id, dialog };
}

export function resolvedEvent(
  seq: number,
  id: string,
  outcome: 'answered' | 'cancelled',
): CommittedEvent {
  return { type: 'resolved', seq, id, outcome };
}

// Images are left out by decision (#979): they need an upload path of their own. A large paste
// rides beside the text, as the TUI parks it, so the questions read the user's own words (#448).
// `mode` is the mode the line was typed in: a submit is refused if it has changed since.
export type ClientMessage =
  | { type: 'submit'; text: string; mode?: Mode; pastes?: PastedText[] }
  | { type: 'abort' }
  | { type: 'mode'; mode: Mode }
  | { type: 'model'; name: string }
  | { type: 'complete'; text: string }
  | { type: 'answer'; id: string; kind: 'approval'; answer: ApprovalAnswer; always?: boolean }
  | { type: 'answer'; id: string; kind: 'question'; answer: QuestionAnswer | null }
  | { type: 'answer'; id: string; kind: 'confirm'; choice: number | 'abort' }
  | { type: 'answer'; id: string; kind: 'model'; name: string | null }
  | { type: 'answer'; id: string; kind: 'session'; path: string | null };

type ParseResult = ClientMessage | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseApprovalAnswer(value: unknown): ApprovalAnswer | { error: string } {
  if (value === true || value === false) return value;
  if (isRecord(value)) {
    if (typeof value.feedback !== 'string') return { error: 'answer.feedback must be a string' };
    return { feedback: value.feedback };
  }
  return { error: 'answer must be true, false or { feedback }' };
}

function parseQuestionAnswer(value: unknown): QuestionAnswer | null | { error: string } {
  if (value === null) return null;
  if (!isRecord(value)) return { error: 'answer must be an object or null' };
  if (typeof value.text !== 'string') return { error: 'answer.text must be a string' };
  if (value.index !== undefined && !isIndex(value.index)) {
    return { error: 'answer.index must be a non-negative integer' };
  }
  if (value.notes !== undefined && typeof value.notes !== 'string') {
    return { error: 'answer.notes must be a string' };
  }
  return {
    text: value.text,
    ...(value.index !== undefined ? { index: value.index } : {}),
    ...(value.notes !== undefined ? { notes: value.notes } : {}),
  };
}

function parseMode(value: unknown): Mode | { error: string } {
  return (
    WIRE_MODES.find(m => m === value) ?? { error: `mode must be one of ${WIRE_MODES.join(', ')}` }
  );
}

function parsePastes(value: unknown): PastedText[] | { error: string } {
  if (!Array.isArray(value)) return { error: 'pastes must be an array' };
  if (value.length > MAX_SUBMIT_PASTES) return { error: `at most ${MAX_SUBMIT_PASTES} pastes` };
  const out: PastedText[] = [];
  const seen = new Set<string>();
  for (const p of value) {
    if (!isRecord(p) || typeof p.marker !== 'string' || typeof p.text !== 'string') {
      return { error: 'each paste must be { marker, text } strings' };
    }
    if (!isPasteMarker(p.marker))
      return { error: 'paste marker is not a [Pasted text #N …] marker' };
    if (seen.has(p.marker)) return { error: 'paste markers must be distinct' };
    seen.add(p.marker);
    out.push({ marker: p.marker, text: p.text });
  }
  return out;
}

function parseSubmit(value: Record<string, unknown>): ParseResult {
  if (typeof value.text !== 'string') return { error: 'text must be a string' };
  const out: Extract<ClientMessage, { type: 'submit' }> = { type: 'submit', text: value.text };
  if (value.mode !== undefined) {
    const mode = parseMode(value.mode);
    if (typeof mode === 'object') return mode;
    out.mode = mode;
  }
  if (value.pastes !== undefined) {
    const pastes = parsePastes(value.pastes);
    if (!Array.isArray(pastes)) return pastes;
    out.pastes = pastes;
  }
  return out;
}

function parseAnswer(value: Record<string, unknown>): ParseResult {
  const id = value.id;
  if (typeof id !== 'string' || id === '') return { error: 'id must be a non-empty string' };
  switch (value.kind) {
    case 'approval': {
      const answer = parseApprovalAnswer(value.answer);
      if (typeof answer === 'object' && 'error' in answer) return answer;
      if (value.always !== undefined && typeof value.always !== 'boolean') {
        return { error: 'always must be a boolean' };
      }
      return {
        type: 'answer',
        id,
        kind: 'approval',
        answer,
        ...(value.always !== undefined ? { always: value.always } : {}),
      };
    }
    case 'question': {
      const answer = parseQuestionAnswer(value.answer);
      if (answer !== null && 'error' in answer) return answer;
      return { type: 'answer', id, kind: 'question', answer };
    }
    case 'confirm': {
      const choice = value.choice;
      if (choice !== 'abort' && !isIndex(choice)) {
        return { error: "choice must be a non-negative integer or 'abort'" };
      }
      return { type: 'answer', id, kind: 'confirm', choice };
    }
    case 'model': {
      const name = value.name;
      if (name !== null && typeof name !== 'string') {
        return { error: 'name must be a string or null' };
      }
      return { type: 'answer', id, kind: 'model', name };
    }
    case 'session': {
      const path = value.path;
      if (path !== null && typeof path !== 'string') {
        return { error: 'path must be a string or null' };
      }
      return { type: 'answer', id, kind: 'session', path };
    }
    default:
      return { error: 'kind must be approval, question, confirm, model or session' };
  }
}

// The trust boundary: the input is JSON.parse output from a network request. What comes back is
// a new object of known fields only, so nothing a tab adds reaches the controller.
export function parseClientMessage(value: unknown): ParseResult {
  if (!isRecord(value)) return { error: 'message must be an object' };
  switch (value.type) {
    case 'submit':
      return parseSubmit(value);
    case 'abort':
      return { type: 'abort' };
    case 'mode': {
      const mode = parseMode(value.mode);
      return typeof mode === 'object' ? mode : { type: 'mode', mode };
    }
    case 'model':
      if (typeof value.name !== 'string' || value.name === '') {
        return { error: 'name must be a non-empty string' };
      }
      return { type: 'model', name: value.name };
    case 'complete':
      if (typeof value.text !== 'string') return { error: 'text must be a string' };
      if (value.text.length > MAX_COMPLETE_CHARS) {
        return { error: `text must be at most ${MAX_COMPLETE_CHARS} chars` };
      }
      return { type: 'complete', text: value.text };
    case 'answer':
      return parseAnswer(value);
    default:
      return { error: 'type must be submit, abort, mode, model, complete or answer' };
  }
}
