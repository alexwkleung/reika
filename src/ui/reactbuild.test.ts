import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWithProductionReact } from './reactbuild.js';

describe('loadWithProductionReact', () => {
  const launchValue = process.env.NODE_ENV;
  beforeEach(() => {
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env.NODE_ENV = launchValue;
  });

  it('sets production for the load, then removes it so children never inherit it', async () => {
    const seen = await loadWithProductionReact(async () => process.env.NODE_ENV);
    expect(seen).toBe('production');
    expect('NODE_ENV' in process.env).toBe(false);
  });

  it('removes it when the load fails', async () => {
    await expect(
      loadWithProductionReact(async () => {
        throw new Error('no build');
      }),
    ).rejects.toThrow('no build');
    expect('NODE_ENV' in process.env).toBe(false);
  });

  it('leaves an explicit NODE_ENV alone', async () => {
    process.env.NODE_ENV = 'development';
    const seen = await loadWithProductionReact(async () => process.env.NODE_ENV);
    expect(seen).toBe('development');
    expect(process.env.NODE_ENV).toBe('development');
  });

  // JSX here compiles to a static `react/jsx-runtime` import, which runs before cli.tsx's body and
  // so picks the development build no matter what the load sets.
  it('has no JSX in the entry point to load React ahead of it', () => {
    const entry = readFileSync(new URL('../cli.tsx', import.meta.url), 'utf8');
    expect(entry).not.toMatch(/<[A-Z][A-Za-z]*[\s/>]/);
  });
});
