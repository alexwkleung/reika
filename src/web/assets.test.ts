import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proofAssets } from './assets.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'reika-assets-'));
  await writeFile(join(root, 'index.html'), '<!doctype html>');
  await writeFile(join(root, 'client.js'), 'void 0;');
  await writeFile(join(root, 'style.css'), 'body{}');
  await writeFile(join(root, 'secret.txt'), 'no');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('proofAssets', () => {
  it('serves the three files with their types', async () => {
    const assets = proofAssets(root);
    const index = await assets('/');
    expect(index?.contentType).toBe('text/html; charset=utf-8');
    expect(Buffer.from(index!.body).toString()).toBe('<!doctype html>');
    expect((await assets('/client.js'))?.contentType).toBe('text/javascript; charset=utf-8');
    expect((await assets('/style.css'))?.contentType).toBe('text/css; charset=utf-8');
  });

  it('serves nothing else', async () => {
    const assets = proofAssets(root);
    for (const path of [
      '/index.html',
      '/secret.txt',
      '/client.js/',
      '/style.css/',
      '//',
      '/../package.json',
      '/./client.js',
      'client.js',
      '',
      '/CLIENT.JS',
    ]) {
      expect(await assets(path)).toBeNull();
    }
  });

  it('answers null when a listed file is missing', async () => {
    expect(await proofAssets(join(root, 'nope'))('/')).toBeNull();
  });
});
