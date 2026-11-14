import { describe, expect, it, vi } from 'vitest';
import type { ImageAttachment } from '../agent/attachments.js';
import { createController } from '../controller.js';
import type { Session, SubmitOptions } from '../session.js';
import type { Config, Message, Profile } from '../types.js';
import {
  approvalDialog,
  confirmDialog,
  DROPPED_MESSAGE_KEYS,
  helloEvent,
  messageEvent,
  modelDialog,
  parseClientMessage,
  PROTOCOL_VERSION,
  questionDialog,
  resetEvent,
  sameState,
  sessionDialog,
  wireMessage,
  wireState,
} from './protocol.js';

type Role = Message['role'];
type Full<R extends Role> = Required<Extract<Message, { role: R }>>;

// Every optional field set, typed Required so a field added to Message later fails to compile
// here until it is decided whether the wire carries it.
const fullUser: Full<'user'> = {
  role: 'user',
  content: 'fix the bug',
  display: '/issue 1',
  nested: true,
  meta: true,
  harness: true,
  mode: 'plan',
  skill: 'issue',
};
const fullAssistant: Full<'assistant'> = {
  role: 'assistant',
  content: 'done',
  toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
  reasoning: 'thinking',
  durationMs: 12,
  sources: ['https://example.com'],
  nested: true,
  compactionNote: true,
  discarded: 'note',
  harnessStop: 'loop',
  planFinal: true,
  planChecks: { at: 3, missing: ['x'], deadUrls: [] },
  reasoningAged: true,
  continuationTail: true,
};
const fullTool: Full<'tool'> = {
  role: 'tool',
  callId: 'c1',
  summary: 'Read a.ts',
  payload: 'x'.repeat(1000),
  payloadId: 'p1',
  aged: true,
  rendered: 'frozen bytes',
  diff: { text: '+ a', path: 'a.ts', added: 1, removed: 0, startLine: 4 },
  command: { text: 'ls', outputTail: 'a.ts', outputTruncated: false },
  changes: { files: [], more: 0 },
  exitCode: 0,
  durationMs: 40,
  nested: true,
};
const fullError: Full<'error'> = { role: 'error', content: 'boom', nested: true };
const fullSystem: Full<'system'> = {
  role: 'system',
  content: 'note',
  tone: 'warn',
  emphasis: 'lead',
  nested: true,
  planWaived: [2],
  skipAutosave: true,
};
const fullCompaction: Full<'compaction'> = { role: 'compaction', content: 'recap', nested: true };
const fullShell: Full<'shell'> = { role: 'shell', command: 'ls', output: 'a.ts', nested: true };

const everyRole: Message[] = [
  fullUser,
  fullAssistant,
  fullTool,
  fullError,
  fullSystem,
  fullCompaction,
  fullShell,
];

describe('wireMessage', () => {
  it('drops exactly the six fields no renderer draws, across every role', () => {
    const dropped = new Set<string>();
    for (const msg of everyRole) {
      const out = Object.keys(wireMessage(msg));
      for (const key of Object.keys(msg)) if (!out.includes(key)) dropped.add(key);
      expect(out.every(k => k in msg)).toBe(true);
    }
    expect([...dropped].sort()).toEqual(
      ['aged', 'continuationTail', 'payload', 'payloadId', 'reasoningAged', 'rendered'].sort(),
    );
    expect([...DROPPED_MESSAGE_KEYS].sort()).toEqual([...dropped].sort());
  });

  it('leaves a tool message with everything a renderer draws and nothing of the payload', () => {
    const { payload, payloadId, aged, rendered, ...kept } = fullTool;
    void [payload, payloadId, aged, rendered];
    expect(wireMessage(fullTool)).toEqual(kept);
    expect(Object.keys(wireMessage(fullTool)).sort()).toEqual(Object.keys(kept).sort());
  });

  it('drops the aging marks off an assistant message and keeps the rest', () => {
    const { reasoningAged, continuationTail, ...kept } = fullAssistant;
    void [reasoningAged, continuationTail];
    expect(Object.keys(wireMessage(fullAssistant)).sort()).toEqual(Object.keys(kept).sort());
    expect(wireMessage(fullAssistant)).toEqual(kept);
  });

  it('keeps every field of the roles with nothing to drop', () => {
    for (const msg of [fullUser, fullError, fullSystem, fullCompaction, fullShell]) {
      expect(wireMessage(msg)).toEqual(msg);
      expect(Object.keys(wireMessage(msg))).toEqual(Object.keys(msg));
    }
  });

  it('builds a new object and leaves its input alone', () => {
    const before = structuredClone(fullTool);
    const out = wireMessage(fullTool);
    expect(out).not.toBe(fullTool);
    expect(fullTool).toEqual(before);
    const bare: Message = { role: 'tool', callId: 'c', summary: 's' };
    expect(wireMessage(bare)).toEqual(bare);
    expect(wireMessage(bare)).not.toBe(bare);
  });

  it('is what the message and reset events carry', () => {
    expect(messageEvent(3, fullTool)).toEqual({
      type: 'message',
      seq: 3,
      message: wireMessage(fullTool),
    });
    expect(resetEvent(4, [fullTool, fullUser])).toEqual({
      type: 'reset',
      seq: 4,
      messages: [wireMessage(fullTool), wireMessage(fullUser)],
    });
    expect(helloEvent(0)).toEqual({ type: 'hello', seq: 0, version: PROTOCOL_VERSION });
  });
});

const profileOf = (model: string, extra: Partial<Profile> = {}): Profile => ({
  model,
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
  ...extra,
});

// The parts of a session wireState and a turn read.
function fakeSession(config: Partial<Config>) {
  const cfg = {
    autoApprove: 'off',
    models: ['local'],
    profiles: { default: profileOf('local') },
    ...config,
  } as Config;
  return {
    profile: 'default',
    bundle: { cwd: '/repo/app', skills: [] },
    config: cfg,
    getSnapshot: () => ({ config: cfg }),
    submit: vi.fn(async (_text: string, opts: SubmitOptions): Promise<Message[]> => {
      opts.onTurnStart?.();
      opts.events?.onUsage?.({ promptTokens: 10, completionTokens: 2 });
      opts.onTurnEnd?.();
      return [];
    }),
  };
}

function booted(config: Partial<Config> = {}) {
  const controller = createController({ mode: 'agent', remember: vi.fn() });
  controller.attachSession(fakeSession(config) as unknown as Session, 'default');
  controller.setStatus('idle');
  return controller;
}

describe('wireState', () => {
  it('reports nulls for what only a booted session knows', () => {
    const controller = createController({ mode: 'plan', remember: vi.fn() });
    expect(wireState(controller)).toEqual({
      mode: 'plan',
      status: 'loading',
      error: null,
      model: null,
      profile: null,
      cwd: null,
      autoApprove: 'off',
      unattended: false,
      usage: { promptTokens: 0, completionTokens: 0 },
      lastUsage: null,
      estimatedContext: null,
      contextWindow: null,
      shrink: { sheds: 0, folds: 0 },
      decodeRate: null,
      queue: [],
      approvals: { approved: 0, declined: 0 },
    });
  });

  it('names the session’s model, profile, cwd and window once booted', () => {
    const controller = booted({ contextWindow: 32000, autoApprove: 'safe', unattended: true });
    expect(wireState(controller)).toMatchObject({
      status: 'idle',
      model: 'local',
      profile: 'default',
      cwd: '/repo/app',
      contextWindow: 32000,
      autoApprove: 'safe',
      unattended: true,
    });
  });

  it('takes the active profile’s window over the config’s', () => {
    const controller = booted({
      contextWindow: 32000,
      profiles: { default: profileOf('local', { contextWindow: 8000 }) },
    });
    expect(wireState(controller).contextWindow).toBe(8000);
  });

  it('carries a queued prompt’s image count, never the image', () => {
    const controller = booted();
    const image = { marker: '[Image 1]', text: 'secret OCR text' } as unknown as ImageAttachment;
    controller.enqueue({ content: 'look at [Image 1]', images: [image], answers: {} });
    controller.enqueue({ content: 'then this', answers: {} });
    const { queue } = wireState(controller);
    expect(queue).toEqual([
      { content: 'look at [Image 1]', images: 1 },
      { content: 'then this', images: 0 },
    ]);
    expect(JSON.stringify(queue)).not.toContain('secret');
  });

  it('is the same state until something a status bar shows changes', async () => {
    const controller = booted();
    const first = wireState(controller);
    expect(sameState(first, wireState(controller))).toBe(true);

    controller.setMode('plan');
    const planned = wireState(controller);
    expect(sameState(first, planned)).toBe(false);

    controller.enqueue({ content: 'later', answers: {} });
    const queued = wireState(controller);
    expect(sameState(planned, queued)).toBe(false);

    await controller.runTurn('hi', {}, {});
    expect(sameState(queued, wireState(controller))).toBe(false);
    expect(wireState(controller).usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it('compares usage regardless of key order', () => {
    const base = wireState(booted());
    const a = { ...base, usage: { promptTokens: 1, completionTokens: 2, cachedTokens: 3 } };
    const b = { ...base, usage: { cachedTokens: 3, completionTokens: 2, promptTokens: 1 } };
    expect(sameState(a, b)).toBe(true);
  });
});

describe('dialog builders', () => {
  it('builds an approval, leaving out what the request did not carry', () => {
    expect(approvalDialog({ tool: 'bash', subject: 'ls', preview: '$ ls' })).toEqual({
      kind: 'approval',
      tool: 'bash',
      subject: 'ls',
      preview: '$ ls',
    });
    expect(
      Object.keys(approvalDialog({ tool: 'bash', subject: 'ls', preview: '$ ls' })),
    ).not.toContain('warnings');
    expect(
      approvalDialog({
        tool: 'edit',
        subject: 'a.ts',
        preview: '+ a',
        startLine: 3,
        warnings: ['outside the project'],
      }),
    ).toEqual({
      kind: 'approval',
      tool: 'edit',
      subject: 'a.ts',
      preview: '+ a',
      startLine: 3,
      warnings: ['outside the project'],
    });
  });

  it('builds a question', () => {
    expect(
      questionDialog({
        question: 'Which?',
        options: [
          { label: 'A', recommended: true },
          { label: 'B', description: 'the other' },
        ],
      }),
    ).toEqual({
      kind: 'question',
      question: 'Which?',
      options: [
        { label: 'A', recommended: true },
        { label: 'B', description: 'the other' },
      ],
    });
  });

  it('builds a confirm, its cursor on row 0 unless told otherwise', () => {
    const spec = {
      title: 'Skill',
      subtitle: '/issue',
      details: ['matched: issue'],
      options: ['a'],
    };
    expect(confirmDialog(spec)).toEqual({ kind: 'confirm', ...spec, initial: 0 });
    expect(Object.keys(confirmDialog(spec))).not.toContain('accept');
    expect(confirmDialog({ ...spec, accept: 'apply' }, 1)).toEqual({
      kind: 'confirm',
      ...spec,
      accept: 'apply',
      initial: 1,
    });
  });

  it('builds the model and session pickers', () => {
    const target = {
      name: 'default',
      model: 'local',
      baseURL: 'http://127.0.0.1:1/v1',
      kind: 'model' as const,
      active: true,
    };
    expect(modelDialog([target])).toEqual({ kind: 'model', targets: [target] });
    const entry = { path: '/repo/history/a.jsonl', savedAt: '2026-01-01', messageCount: 4 };
    expect(sessionDialog({ heading: 'this project', entries: [entry] })).toEqual({
      kind: 'session',
      heading: 'this project',
      entries: [entry],
    });
  });
});

describe('parseClientMessage', () => {
  const valid = [
    { type: 'submit', text: '/model' },
    { type: 'abort' },
    { type: 'answer', id: 'd1', kind: 'approval', answer: true },
    { type: 'answer', id: 'd1', kind: 'approval', answer: false, always: false },
    { type: 'answer', id: 'd1', kind: 'approval', answer: true, always: true },
    { type: 'answer', id: 'd1', kind: 'approval', answer: { feedback: 'use pnpm' } },
    { type: 'answer', id: 'd2', kind: 'question', answer: null },
    { type: 'answer', id: 'd2', kind: 'question', answer: { text: 'A' } },
    { type: 'answer', id: 'd2', kind: 'question', answer: { text: 'A', index: 0, notes: 'n' } },
    { type: 'answer', id: 'd3', kind: 'confirm', choice: 0 },
    { type: 'answer', id: 'd3', kind: 'confirm', choice: 'abort' },
    { type: 'answer', id: 'd4', kind: 'model', name: 'kimi' },
    { type: 'answer', id: 'd4', kind: 'model', name: null },
    { type: 'answer', id: 'd5', kind: 'session', path: '/repo/history/a.jsonl' },
    { type: 'answer', id: 'd5', kind: 'session', path: null },
  ];

  it.each(valid)('accepts %j as it is', message => {
    const parsed = parseClientMessage(message);
    expect(parsed).toEqual(message);
    expect(parsed).not.toBe(message);
  });

  it('drops keys it does not know, at every level', () => {
    expect(parseClientMessage({ type: 'submit', text: 'hi', images: ['x'] })).toEqual({
      type: 'submit',
      text: 'hi',
    });
    expect(parseClientMessage({ type: 'abort', force: true })).toEqual({ type: 'abort' });
    expect(
      parseClientMessage({
        type: 'answer',
        id: 'd1',
        kind: 'approval',
        answer: { feedback: 'no', extra: 1 },
        reason: 'x',
      }),
    ).toEqual({ type: 'answer', id: 'd1', kind: 'approval', answer: { feedback: 'no' } });
    expect(
      parseClientMessage({
        type: 'answer',
        id: 'd2',
        kind: 'question',
        answer: { text: 'A', extra: true },
      }),
    ).toEqual({ type: 'answer', id: 'd2', kind: 'question', answer: { text: 'A' } });
    expect(
      parseClientMessage({ type: 'answer', id: 'd3', kind: 'confirm', choice: 1, name: 'x' }),
    ).toEqual({ type: 'answer', id: 'd3', kind: 'confirm', choice: 1 });
  });

  const answer = (kind: string, rest: Record<string, unknown>) => ({
    type: 'answer',
    id: 'd1',
    kind,
    ...rest,
  });

  const rejected: [string, unknown, string][] = [
    ['null', null, 'message'],
    ['a string', 'submit', 'message'],
    ['an array', [{ type: 'abort' }], 'message'],
    ['an empty object', {}, 'type'],
    ['an unknown type', { type: 'shout' }, 'type'],
    ['submit without text', { type: 'submit' }, 'text'],
    ['submit with a number', { type: 'submit', text: 5 }, 'text'],
    ['answer without id', { type: 'answer', kind: 'model', name: null }, 'id'],
    ['answer with an empty id', { type: 'answer', id: '', kind: 'model', name: null }, 'id'],
    ['answer with an unknown kind', answer('vote', {}), 'kind'],
    ['approval with "yes"', answer('approval', { answer: 'yes' }), 'answer'],
    ['approval without answer', answer('approval', {}), 'answer'],
    ['approval with numeric feedback', answer('approval', { answer: { feedback: 1 } }), 'feedback'],
    ['approval with always "true"', answer('approval', { answer: true, always: 'true' }), 'always'],
    ['question with a string answer', answer('question', { answer: 'A' }), 'answer'],
    ['question without text', answer('question', { answer: { index: 0 } }), 'text'],
    ['question with index -1', answer('question', { answer: { text: 'A', index: -1 } }), 'index'],
    ['question with index 1.5', answer('question', { answer: { text: 'A', index: 1.5 } }), 'index'],
    [
      'question with numeric notes',
      answer('question', { answer: { text: 'A', notes: 1 } }),
      'notes',
    ],
    ['confirm with choice "1"', answer('confirm', { choice: '1' }), 'choice'],
    ['confirm with choice -1', answer('confirm', { choice: -1 }), 'choice'],
    ['confirm without choice', answer('confirm', {}), 'choice'],
    ['model with name 5', answer('model', { name: 5 }), 'name'],
    ['model without name', answer('model', {}), 'name'],
    ['session with path {}', answer('session', { path: {} }), 'path'],
  ];

  it.each(rejected)('rejects %s, naming the field', (_label, message, field) => {
    const parsed = parseClientMessage(message);
    expect(parsed).toHaveProperty('error');
    expect((parsed as { error: string }).error).toContain(field);
  });
});
