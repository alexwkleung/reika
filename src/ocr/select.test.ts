import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';

const systemOcr = vi.fn((..._a: unknown[]) => 'system');
const visionOcr = vi.fn((..._a: unknown[]) => 'vision');
vi.mock('./system.js', () => ({ systemOcr }));
vi.mock('./vision.js', () => ({ visionOcr }));

const { imageReader } = await import('./select.js');

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
