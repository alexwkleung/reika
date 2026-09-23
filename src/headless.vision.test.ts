import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Config, ContextBundle } from './types.js';

// Headless reads an @-mentioned image through the same reader App does (#130): a configured vision
// model, not system OCR — which on Linux does not exist, so the image was refused outright.
const visionOcr = vi.fn(() => async () => ({ ok: true as const, text: 'A red error banner.' }));
const systemOcr = vi.fn(() => async () => ({ ok: false as const, reason: 'unavailable' as const }));
vi.mock('./ocr/vision.js', () => ({ visionOcr }));
vi.mock('./ocr/system.js', () => ({ systemOcr }));

const { buildHeadlessInput } = await import('./headless.js');

const dir = await mkdtemp(join(tmpdir(), 'reika-headless-vision-'));
await writeFile(join(dir, 'shot.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
afterAll(() => rm(dir, { recursive: true, force: true }));

const bundle = { cwd: dir, skills: [] } as unknown as ContextBundle;
const config = {
  baseURL: 'http://main:8080/v1',
  apiKey: 'main-key',
  pasteFetch: 'off',
  skillAuto: 'off',
  visionModel: 'qwen-vl',
} as unknown as Config;

describe('buildHeadlessInput with a vision model', () => {
  it('describes an @-mentioned image with the vision model', async () => {
    const out = await buildHeadlessInput('what is wrong in @shot.png', config, bundle, 'agent');
    expect(visionOcr).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen-vl' }));
    expect(systemOcr).not.toHaveBeenCalled();
    expect(out.modelText).toContain('A red error banner.');
  });
});
