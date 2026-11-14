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
import type { Approvals } from '../ui/summary.js';

// The JSON a local server sends a browser tab and accepts back (#584/#595). Types only on the
// import side, so nothing here loads Ink, React or a server.

export const PROTOCOL_VERSION = 1;

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
};

export function wireState(controller: Controller): WireState {
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
  | { type: 'resolved'; seq: number; id: string; outcome: 'answered' | 'cancelled' };

export type LiveEvent =
  | { type: 'live'; live: WireLive }
  | { type: 'delta'; channel: 'content' | 'reasoning' | 'tool'; text: string };

export type ServerEvent = CommittedEvent | LiveEvent;

export function helloEvent(seq: number): CommittedEvent {
  return { type: 'hello', seq, version: PROTOCOL_VERSION };
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

// Version 1 carries typed text only. Images are left out by decision (#979): they need an upload
// path of their own. A large paste needs nothing, since a browser text box can hold it.
export type ClientMessage =
  | { type: 'submit'; text: string }
  | { type: 'abort' }
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
      if (typeof value.text !== 'string') return { error: 'text must be a string' };
      return { type: 'submit', text: value.text };
    case 'abort':
      return { type: 'abort' };
    case 'answer':
      return parseAnswer(value);
    default:
      return { error: 'type must be submit, abort or answer' };
  }
}
