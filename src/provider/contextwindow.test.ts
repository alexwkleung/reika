import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  floorContextWindow,
  modelsEndpoints,
  parseContextWindow,
  probeContextWindow,
} from './contextwindow.js';
import { API_USER_AGENT } from '../version.js';

const llamaListing = (n_ctx: number, id = 'qwen3.8-27b', aliases: string[] = []) => ({
  object: 'list',
  data: [
    {
      id,
      aliases,
      object: 'model',
      owned_by: 'llamacpp',
      meta: { n_ctx, n_ctx_train: 262144, n_vocab: 151936 },
    },
  ],
});

describe('floorContextWindow', () => {
  it('rounds down to the thousand', () => {
    expect(floorContextWindow(24555)).toBe(24000);
    expect(floorContextWindow(24000)).toBe(24000);
    expect(floorContextWindow(32768)).toBe(32000);
    expect(floorContextWindow(131072)).toBe(131000);
  });

  it('reports nothing for a window under a thousand or a non-number', () => {
    expect(floorContextWindow(512)).toBeUndefined();
    expect(floorContextWindow(0)).toBeUndefined();
    expect(floorContextWindow(NaN)).toBeUndefined();
    expect(floorContextWindow(Infinity)).toBeUndefined();
  });
});

describe('parseContextWindow', () => {
  it('reads llama.cpp meta.n_ctx for the configured model', () => {
    expect(parseContextWindow(llamaListing(24576), 'qwen3.8-27b')).toBe(24000);
  });

  it('never reads n_ctx_train — the trained length is not the served slot', () => {
    const body = {
      data: [{ id: 'm', meta: { n_ctx_train: 262144 } }],
    };
    expect(parseContextWindow(body, 'm')).toBeUndefined();
  });

  it('matches through llama.cpp aliases', () => {
    expect(parseContextWindow(llamaListing(16384, 'model.gguf', ['coder']), 'coder')).toBe(16000);
  });

  it('falls back to a lone entry whatever its id', () => {
    expect(parseContextWindow(llamaListing(8192, 'whatever-loaded'), 'my-model')).toBe(8000);
  });

  it('reports nothing when several models are listed and none is ours', () => {
    const body = {
      data: [
        { id: 'a', meta: { n_ctx: 8192 } },
        { id: 'b', meta: { n_ctx: 16384 } },
      ],
    };
    expect(parseContextWindow(body, 'c')).toBeUndefined();
  });

  it('reads a top-level n_ctx, the shape a router in front of llama.cpp lifts it to', () => {
    const body = {
      object: 'list',
      data: [
        { id: 'lfm2.5-8b-a1b', object: 'model' },
        { id: 'hermes-3-8b', object: 'model', n_ctx: 16384 },
      ],
    };
    expect(parseContextWindow(body, 'hermes-3-8b')).toBe(16000);
    expect(parseContextWindow(body, 'lfm2.5-8b-a1b')).toBeUndefined();
  });

  it('reads vLLM max_model_len and the generic context_length', () => {
    expect(parseContextWindow({ data: [{ id: 'v', max_model_len: 40960 }] }, 'v')).toBe(40000);
    expect(parseContextWindow({ data: [{ id: 'p', context_length: 65536 }] }, 'p')).toBe(65000);
  });

  it('reports nothing for a listing with no window field (Ollama, OpenAI, a bare router)', () => {
    const body = {
      object: 'list',
      data: [
        { id: 'gpt-oss-20b', object: 'model' },
        { id: 'coder', object: 'model', aliased_to: 'qwen3.8-27b' },
      ],
    };
    expect(parseContextWindow(body, 'coder')).toBeUndefined();
  });

  it('survives shapes that are not a listing at all', () => {
    expect(parseContextWindow(null, 'm')).toBeUndefined();
    expect(parseContextWindow('nope', 'm')).toBeUndefined();
    expect(parseContextWindow({ data: 'nope' }, 'm')).toBeUndefined();
    expect(parseContextWindow({ data: [null, 3, { id: 'm', meta: { n_ctx: 'x' } }] }, 'm')).toBe(
      undefined,
    );
  });
});

describe('modelsEndpoints', () => {
  it('tries only {base}/models under a /v1 base', () => {
    expect(modelsEndpoints('http://localhost:8080/v1/')).toEqual([
      'http://localhost:8080/v1/models',
    ]);
  });

  it('falls through to /v1/models when the base has no /v1 suffix', () => {
    expect(modelsEndpoints('http://127.0.0.1:8000')).toEqual([
      'http://127.0.0.1:8000/models',
      'http://127.0.0.1:8000/v1/models',
    ]);
  });
});

describe('probeContextWindow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reaches /v1/models when a bare base answers 404 on /models', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/v1/models')
        ? { ok: true, json: async () => ({ data: [{ id: 'm', n_ctx: 24576 }] }) }
        : { ok: false, json: async () => ({ error: 'not found' }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      probeContextWindow({ baseURL: 'http://127.0.0.1:8000', apiKey: '', model: 'm' }),
    ).resolves.toEqual({ window: 24000, reached: true });
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      'http://127.0.0.1:8000/models',
      'http://127.0.0.1:8000/v1/models',
    ]);
  });

  const opts = { baseURL: 'http://localhost:8080/v1/', apiKey: 'k', model: 'qwen3.8-27b' };

  it('GETs {baseURL}/models with the key and returns the floored window', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => llamaListing(24576) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeContextWindow(opts)).resolves.toEqual({ window: 24000, reached: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(API_USER_AGENT);
  });

  it('reports no window on a non-2xx, a bad body, or a listing without one — reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(probeContextWindow(opts)).resolves.toEqual({ reached: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error('x');
        },
      })),
    );
    await expect(probeContextWindow(opts)).resolves.toEqual({ reached: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
    );
    await expect(probeContextWindow(opts)).resolves.toEqual({ reached: true });
  });

  it('reports unreached when nothing answers — never a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(probeContextWindow(opts)).resolves.toEqual({ reached: false });
  });
});
