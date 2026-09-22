import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';

const systemOcr = vi.fn((..._a: unknown[]) => 'system');
const visionOcr = vi.fn((..._a: unknown[]) => 'vision');
vi.mock('./system.js', () => ({ systemOcr }));
vi.mock('./vision.js', () => ({ visionOcr }));

const { imageReader, pasteIsNative } = await import('./select.js');

const base = {
  baseURL: 'http://main:8080/v1',
  apiKey: 'main-key',
  ocrLangs: ['en-US'],
} as unknown as Config;

describe('imageReader', () => {
  it('uses system OCR when no vision model is configured', () => {
    expect(imageReader(base)).toBe('system');
    expect(systemOcr).toHaveBeenCalledWith(['en-US']);
    expect(visionOcr).not.toHaveBeenCalled();
  });

  it('routes through the vision model, inheriting the main server when unset', () => {
    expect(imageReader({ ...base, visionModel: 'qwen-vl' })).toBe('vision');
    expect(visionOcr).toHaveBeenLastCalledWith({
      model: 'qwen-vl',
      baseURL: 'http://main:8080/v1',
      apiKey: 'main-key',
    });
  });

  it('honors a dedicated vision server and key', () => {
    imageReader({
      ...base,
      visionModel: 'qwen-vl',
      visionBaseURL: 'http://vision:8081/v1',
      visionApiKey: 'v-key',
    });
    expect(visionOcr).toHaveBeenLastCalledWith({
      model: 'qwen-vl',
      baseURL: 'http://vision:8081/v1',
      apiKey: 'v-key',
    });
  });
});

describe('pasteIsNative', () => {
  it('is off when the route is unset', () => {
    expect(pasteIsNative(base)).toBe(false);
  });

  it('is on only for the native route', () => {
    expect(pasteIsNative({ ...base, vision: 'native' })).toBe(true);
    expect(pasteIsNative({ ...base, vision: 'describe' })).toBe(false);
  });

  // The route and the reader are separate decisions: a profile can name a describer and still not
  // be native. Reading through REIKA_VISION_MODEL for this would skip the reader whenever a
  // describer was configured, which is the common local setup.
  it('ignores a configured describer', () => {
    expect(pasteIsNative({ ...base, visionModel: 'qwen-vl' })).toBe(false);
  });
});
