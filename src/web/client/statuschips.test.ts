import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { WireState } from '../protocol.js';
import { shortenMiddle, statusStrip } from './statuschips.js';
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
  preparing: false,
  stage: null,
  modelPinned: false,
  session: null,
  ...over,
});

const strip = (s: WireState, stream: Parameters<typeof statusStrip>[1] = 'open') =>
  statusStrip(s, stream);
const texts = (s: WireState, stream: Parameters<typeof statusStrip>[1] = 'open') =>
  strip(s, stream).map(i => i.text);

describe('statusStrip', () => {
  it('a fresh session with no window: just the folder', () => {
    expect(strip(state())).toEqual([{ kind: 'path', text: '/repo' }]);
  });

  it('a session with usage, a window, sheds and a cache hit, in order, with no mode or model', () => {
    const items = strip(
      state({
        mode: 'plan',
        status: 'busy',
        autoApprove: 'safe',
        usage: { promptTokens: 12_400, completionTokens: 830 },
        lastUsage: { promptTokens: 20_000, completionTokens: 100, cachedTokens: 18_000 },
        contextWindow: 32_000,
        decodeRate: 21.4,
        shrink: { sheds: 2, folds: 1 },
      }),
    );
    expect(items.map(i => i.text)).toEqual([
      'auto approve',
      '63% of 32k',
      '12k ↑ 830 ↓',
      '21 tok/s',
      'cache 90%',
      '2 sheds · 1 fold',
      '/repo',
    ]);
    expect(items[1]).toMatchObject({
      kind: 'meter',
      fill: 0.625,
      title: 'ctx 20k/32k (63%)',
      warn: false,
    });
    expect(items[4]).toMatchObject({ title: '90% cached (18k)' });
  });

  it('shows the window at 0% before any request, and warns past 80%', () => {
    expect(strip(state({ contextWindow: 32_000 }))[0]).toMatchObject({
      kind: 'meter',
      fill: 0,
      text: '0% of 32k',
      warn: false,
    });
    expect(strip(state({ estimatedContext: 900, contextWindow: 1000 }))[0]).toMatchObject({
      text: '90% of 1.0k',
      warn: true,
    });
    expect(strip(state({ estimatedContext: 1200, contextWindow: 1000 }))[0]).toMatchObject({
      fill: 1,
    });
  });

  it('counts the context with no bar when no window is known', () => {
    expect(strip(state({ estimatedContext: 4200 }))[0]).toMatchObject({
      kind: 'meter',
      fill: null,
      text: 'ctx 4.2k',
    });
  });

  it('marks estimated usage', () => {
    expect(
      texts(state({ usage: { promptTokens: 5, completionTokens: 1, estimated: true } })),
    ).toContain('~5 ↑ ~1 ↓');
  });

  it('tags follow the TUI: bypass over unattended, none in chat or shell', () => {
    expect(texts(state({ autoApprove: 'bypass', unattended: true }))).toContain('bypass approvals');
    expect(texts(state({ autoApprove: 'bypass', unattended: true }))).not.toContain('unattended');
    expect(texts(state({ unattended: true }))).toContain('unattended');
    expect(texts(state({ mode: 'chat', autoApprove: 'safe', unattended: true }))).toEqual([
      '/repo',
    ]);
  });

  it('names the stream when it is not open, before the folder', () => {
    expect(strip(state(), 'reconnecting')).toEqual([
      { kind: 'alert', text: 'reconnecting' },
      { kind: 'path', text: '/repo' },
    ]);
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
  it('draws the tag, the meter, the folder and a session error', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, {
        session: state({
          error: 'boot failed',
          autoApprove: 'safe',
          contextWindow: 32_000,
          estimatedContext: 16_000,
        }),
        stream: 'open',
      }),
    );
    expect(html).toContain('<div class="status-error" role="alert">boot failed</div>');
    expect(html).toContain('<span class="status-tag status-tag--auto-approve">auto approve</span>');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('style="width:50%"');
    expect(html).toContain('50% of 32k');
    expect(html).toContain('<span class="status-path" title="/repo">/repo</span>');
    expect(renderToStaticMarkup(createElement(StatusLine, { session: null, stream: null }))).toBe(
      '',
    );
  });
});
