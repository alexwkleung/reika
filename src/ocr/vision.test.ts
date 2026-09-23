import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetStreamDispatcher } from '../provider/dispatcher.js';
import {
  parseVisionResponse,
  sniffImageMime,
  VISION_PROMPT,
  visionOcr,
  visionRequest,
} from './vision.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SETTINGS = { model: 'qwen-vl', baseURL: 'http://localhost:8080/v1/', apiKey: 'k' };

afterEach(() => {
  vi.unstubAllGlobals();
  resetStreamDispatcher();
});

describe('sniffImageMime', () => {
  it('recognizes the formats the mention regex admits', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageMime(webp)).toBe('image/webp');
    expect(sniffImageMime(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('image/bmp');
    expect(sniffImageMime(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe('image/tiff');
    expect(sniffImageMime(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]))).toBe('image/tiff');
  });

  it('falls back to PNG for unknown bytes — the clipboard format', () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([]))).toBe('image/png');
  });
});

describe('visionRequest', () => {
  it('builds the OpenAI multimodal user message with a base64 data URL', () => {
    const body = visionRequest('qwen-vl', PNG) as {
      model: string;
      stream: boolean;
      messages: {
        role: string;
        content: { type: string; text?: string; image_url?: { url: string } }[];
      }[];
    };
    expect(body.model).toBe('qwen-vl');
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    const [text, image] = body.messages[0].content;
    expect(body.messages[0].role).toBe('user');
    expect(text).toEqual({ type: 'text', text: VISION_PROMPT });
    expect(image.type).toBe('image_url');
    expect(image.image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    );
  });
});

describe('parseVisionResponse', () => {
  it('reads a plain string content', () => {
    expect(parseVisionResponse({ choices: [{ message: { content: '  hello\n' } }] })).toEqual({
      ok: true,
      text: 'hello',
    });
  });

  it('joins text parts when a server echoes the multimodal shape', () => {
    const body = {
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'image_url', image_url: { url: 'x' } },
              { type: 'text', text: 'b' },
            ],
          },
        },
      ],
    };
    expect(parseVisionResponse(body)).toEqual({ ok: true, text: 'ab' });
  });

  it('maps an empty answer to no-text, not a failure', () => {
    expect(parseVisionResponse({ choices: [{ message: { content: '   ' } }] })).toEqual({
      ok: false,
      reason: 'no-text',
    });
    expect(parseVisionResponse({ choices: [{ message: { content: null } }] })).toEqual({
      ok: false,
      reason: 'no-text',
    });
  });

  it('reports a body with no choices as a failure', () => {
    expect(parseVisionResponse({ error: { message: 'boom' } })).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(parseVisionResponse(null)).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('visionOcr', () => {
  it('POSTs to <baseURL>/chat/completions with the bearer key and returns the description', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'a stack trace' } }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await visionOcr(SETTINGS)(PNG);
    expect(outcome).toEqual({ ok: true, text: 'a stack trace' });
    // The dispatcher probe issues a `data:` fetch first; the real POST is the last call.
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const sent = JSON.parse(init.body as string) as { model: string; stream: boolean };
    expect(sent.model).toBe('qwen-vl');
    expect(sent.stream).toBe(false);
  });

  it('turns a non-2xx into a failed outcome naming the model and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('model not found', { status: 404, statusText: 'Not Found' })),
    );
    const outcome = await visionOcr(SETTINGS)(PNG);
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('qwen-vl returned 404');
    expect((outcome as { detail: string }).detail).toContain('model not found');
  });

  it('turns a network error into a failed outcome, never a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('data:')) return new Response('');
        throw new Error('ECONNREFUSED');
      }),
    );
    const outcome = await visionOcr(SETTINGS)(PNG);
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('ECONNREFUSED');
  });

  it('reports a non-JSON body as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 })),
    );
    const outcome = await visionOcr(SETTINGS)(PNG);
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('non-JSON');
  });
});
