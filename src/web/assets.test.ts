import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_NOT_BUILT, clientAssets } from './assets.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'reika-assets-'));
  await writeFile(join(root, 'index.html'), '<!doctype html>');
  await writeFile(join(root, 'secret.txt'), 'no');
  await writeFile(join(root, 'app.js'), 'export {};');
  await writeFile(join(root, 'app.css'), ':root{}');
  await writeFile(join(root, 'favicon.svg'), '<svg/>');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('clientAssets', () => {
  it('serves the built page with its types', async () => {
    const assets = clientAssets(root);
    const index = await assets('/');
    expect(index?.contentType).toBe('text/html; charset=utf-8');
    expect(Buffer.from(index!.body).toString()).toBe('<!doctype html>');
    const js = await assets('/app.js');
    expect(js?.contentType).toBe('text/javascript; charset=utf-8');
    expect(Buffer.from(js!.body).toString()).toBe('export {};');
    expect((await assets('/app.css'))?.contentType).toBe('text/css; charset=utf-8');
    expect((await assets('/favicon.svg'))?.contentType).toBe('image/svg+xml');
  });

  it('serves nothing else', async () => {
    const assets = clientAssets(root);
    for (const path of [
      '/index.html',
      '/client.js',
      '/style.css',
      '/favicon.ico',
      '/secret.txt',
      '/app.js/',
      '//',
      '/../package.json',
      '/./app.js',
      'app.js',
      '',
      '/APP.JS',
    ]) {
      expect(await assets(path)).toBeNull();
    }
  });

  it('answers / with how to build when the page is missing, and 404s the rest', async () => {
    const assets = clientAssets(join(root, 'nope'));
    const index = await assets('/');
    expect(index?.contentType).toBe('text/plain; charset=utf-8');
    expect(index?.body).toBe(CLIENT_NOT_BUILT);
    expect(CLIENT_NOT_BUILT).toContain('pnpm run build:web');
    expect(await assets('/app.js')).toBeNull();
    expect(await assets('/app.css')).toBeNull();
  });
});
