import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { WireState } from '../protocol.js';
import { shortenMiddle, statusLineChips } from './statuschips.js';
import { StatusLine } from './StatusLine.js';

const state = (over: Partial<WireState> = {}): WireState => ({
  mode: 'agent',
  status: 'idle',
  error: null,
  model: 'local-model',
  profile: 'default',
  cwd: '/repo',
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
  ...over,
});

const texts = (s: WireState, turns = 0, stream: Parameters<typeof statusLineChips>[2] = 'open') =>
  statusLineChips(s, turns, stream).map(c => c.text);

describe('statusLineChips', () => {
  it('a fresh session: mode, model, turn and status', () => {
    expect(texts(state())).toEqual(['agent', 'local-model', 'turn 0', 'idle', '/repo']);
    expect(statusLineChips(state(), 0, 'open')[0]!.tone).toBe('mode-agent');
  });

  it('a busy session with usage, a known window, sheds and a cache hit, in the TUI order', () => {
    const chips = texts(
      state({
        mode: 'plan',
        status: 'busy',
        autoApprove: 'safe',
        usage: { promptTokens: 12_400, completionTokens: 830 },
        lastUsage: { promptTokens: 20_000, completionTokens: 100, cachedTokens: 18_000 },
        contextWindow: 24_000,
        decodeRate: 21.4,
        shrink: { sheds: 2, folds: 1 },
      }),
      4,
    );
    expect(chips).toEqual([
      'plan',
      'auto approve',
      'local-model',
      'turn 4',
      'busy',
      '12k↑ 830↓',
      '21 tok/s',
      'ctx 20k/24k (83%)',
      '2 sheds · 1 fold',
      '90% cached (18k)',
      '/repo',
    ]);
  });

  it('warns on a full context and marks estimated usage', () => {
    const chips = statusLineChips(
      state({
        estimatedContext: 900,
        contextWindow: 1000,
        usage: { promptTokens: 5, completionTokens: 1, estimated: true },
      }),
      0,
      'open',
    );
    expect(chips.find(c => c.text.startsWith('ctx'))).toEqual({
      text: 'ctx 900/1.0k (90%)',
      tone: 'warning',
    });
    expect(chips.some(c => c.text === '~5↑ ~1↓')).toBe(true);
  });

  it('badges follow the TUI: bypass over unattended, none in chat or shell', () => {
    expect(texts(state({ autoApprove: 'bypass', unattended: true }))).toContain('bypass approvals');
    expect(texts(state({ autoApprove: 'bypass', unattended: true }))).not.toContain('unattended');
    expect(texts(state({ unattended: true }))).toContain('unattended');
    expect(texts(state({ mode: 'chat', autoApprove: 'safe', unattended: true }))).toEqual([
      'chat',
      'local-model',
      'turn 0',
      'idle',
      '/repo',
    ]);
  });

  it('names the stream when it is not open', () => {
    expect(texts(state(), 0, 'reconnecting').at(-1)).toBe('reconnecting');
  });
});

describe('shortenMiddle', () => {
  it('keeps both ends of a long path', () => {
    expect(shortenMiddle('/a/b', 10)).toBe('/a/b');
    const out = shortenMiddle('/repo/packages/web/src/very/deep/folder', 20);
    expect(out).toHaveLength(20);
    expect(out.startsWith('/repo/pack')).toBe(true);
    expect(out.endsWith('p/folder')).toBe(true);
    expect(out).toContain('…');
  });
});

describe('StatusLine', () => {
  it('draws the chips and a session error', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, {
        session: state({ error: 'boot failed' }),
        turns: 1,
        stream: 'open',
      }),
    );
    expect(html).toContain('status-chip--mode-agent');
    expect(html).toContain('turn 1');
    expect(html).toContain('<div class="status-error" role="alert">boot failed</div>');
    expect(
      renderToStaticMarkup(createElement(StatusLine, { session: null, turns: 0, stream: null })),
    ).toBe('');
  });
});
