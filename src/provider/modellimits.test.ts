import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  indexCatalog,
  isCatalogEligible,
  loadModelCatalog,
  lookupModelLimits,
  MODEL_CATALOG_URL,
  needsLimitsProbe,
  probeModelLimits,
  type CatalogIndex,
} from './modellimits.js';

const HOSTED = 'https://router.example.com/v1';

const catalogBody = {
  router: {
    id: 'router',
    api: 'https://router.example.com/v1/',
    models: {
      'big-flash': { id: 'big-flash', limit: { context: 1048576, output: 131072 } },
      'input-capped': {
        id: 'input-capped',
        limit: { context: 1050000, input: 922000, output: 128000 },
      },
      'no-limits': { id: 'no-limits' },
    },
  },
  other: {
    id: 'other',
    api: 'https://other.example.net/v1',
    models: { 'big-flash': { limit: { context: 32768, output: 4096 } } },
  },
  'no-api': { id: 'no-api', models: { 'big-flash': { limit: { context: 8192, output: 1024 } } } },
};

describe('indexCatalog', () => {
  const index = indexCatalog(catalogBody);

  it('keys by normalized api base and floors the window like an endpoint probe', () => {
    expect(lookupModelLimits(index, HOSTED, 'big-flash')).toEqual({
      window: 1048000,
      maxOutput: 131072,
    });
    expect(lookupModelLimits(index, `${HOSTED}//`, 'big-flash')).toBeDefined();
  });

  it('takes the input cap when it is below the total', () => {
    expect(lookupModelLimits(index, HOSTED, 'input-capped')?.window).toBe(922000);
  });

  it("never answers with another provider's entry for the same model id", () => {
    expect(lookupModelLimits(index, 'https://third.example.org/v1', 'big-flash')).toBeUndefined();
    expect(lookupModelLimits(index, 'https://other.example.net/v1', 'big-flash')?.window).toBe(
      32000,
    );
  });

  it('skips entries with no limits and providers with no api', () => {
    expect(lookupModelLimits(index, HOSTED, 'no-limits')).toBeUndefined();
    expect(Object.keys(index)).toHaveLength(2);
  });

  it('survives garbage', () => {
    expect(indexCatalog(null)).toEqual({});
    expect(indexCatalog({ x: { api: 1 }, y: null })).toEqual({});
  });
});

describe('isCatalogEligible', () => {
  it('rules out loopback, private and unparseable hosts', () => {
    expect(isCatalogEligible('http://127.0.0.1:8000')).toBe(false);
    expect(isCatalogEligible('http://localhost:11434/v1')).toBe(false);
    expect(isCatalogEligible('http://192.168.1.20:8080/v1')).toBe(false);
    expect(isCatalogEligible('not a url')).toBe(false);
    expect(isCatalogEligible(HOSTED)).toBe(true);
  });
});

describe('needsLimitsProbe', () => {
  it('asks a hosted profile with a configured window for its output cap', () => {
    expect(needsLimitsProbe({ baseURL: HOSTED, contextWindow: 300000 })).toBe(true);
    expect(
      needsLimitsProbe({ baseURL: HOSTED, contextWindow: 300000, maxOutputTokens: 131072 }),
    ).toBe(false);
  });

  it('leaves a local server with a configured window alone', () => {
    expect(needsLimitsProbe({ baseURL: 'http://127.0.0.1:8000', contextWindow: 24000 })).toBe(
      false,
    );
    expect(needsLimitsProbe({ baseURL: 'http://127.0.0.1:8000' })).toBe(true);
  });
});

describe('probeModelLimits', () => {
  afterEach(() => vi.unstubAllGlobals());
  const index = indexCatalog(catalogBody);
  const bareListing = { object: 'list', data: [{ id: 'big-flash', object: 'model' }] };
  const stubModels = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  const profile = { baseURL: HOSTED, apiKey: 'k', model: 'big-flash' };

  it('falls back to the catalog when the listing carries no window', async () => {
    stubModels(bareListing);
    const probe = await probeModelLimits(profile, async () => index);
    expect(probe).toEqual({
      reached: true,
      window: 1048000,
      windowSource: 'catalog',
      maxOutput: 131072,
    });
  });

  it("prefers the endpoint's window and still takes the catalog's output cap", async () => {
    stubModels({ data: [{ id: 'big-flash', max_model_len: 65536 }] });
    const probe = await probeModelLimits(profile, async () => index);
    expect(probe).toMatchObject({ window: 65000, windowSource: 'endpoint', maxOutput: 131072 });
  });

  it('with a configured window, asks only the catalog and returns only the cap', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const probe = await probeModelLimits({ ...profile, contextWindow: 300000 }, async () => index);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probe).toEqual({ reached: true, maxOutput: 131072 });
  });

  it('never consults the catalog for a local server', async () => {
    stubModels(bareListing);
    const catalog = vi.fn(async (): Promise<CatalogIndex> => index);
    await probeModelLimits({ ...profile, baseURL: 'http://127.0.0.1:8000/v1' }, catalog);
    expect(catalog).not.toHaveBeenCalled();
  });

  it('reports nothing for a model the catalog does not list', async () => {
    stubModels(bareListing);
    const probe = await probeModelLimits({ ...profile, model: 'unlisted' }, async () => index);
    expect(probe).toEqual({ reached: true });
  });
});

describe('loadModelCatalog', () => {
  afterEach(() => vi.unstubAllGlobals());
  const cachePath = () => join(mkdtempSync(join(tmpdir(), 'reika-catalog-')), 'model-limits.json');

  it('fetches once, writes the compact index, and serves the cache after', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(catalogBody), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const path = cachePath();
    const first = await loadModelCatalog(path);
    expect(fetchSpy).toHaveBeenCalledWith(MODEL_CATALOG_URL, expect.anything());
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(first);
    await loadModelCatalog(path);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('serves a stale cache when the refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const path = cachePath();
    const index = indexCatalog(catalogBody);
    writeFileSync(path, JSON.stringify(index));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(path, old, old);
    expect(await loadModelCatalog(path)).toEqual(index);
  });

  it('returns undefined with no cache and no network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    expect(await loadModelCatalog(cachePath())).toBeUndefined();
  });
});
