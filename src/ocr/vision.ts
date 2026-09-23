import { streamDispatcher } from '../provider/dispatcher.js';
import type { OcrOutcome, OcrProvider } from './types.js';

// A vision model standing in for system OCR (issue #130). Same contract as `systemOcr`: image
// bytes in, text out. The model itself never receives the image — the vision model reads it and
// hands back a text description that rides into the prompt as an <image> block exactly the way
// OCR text does. That keeps the string-only context pipeline (serialization, aging, compaction)
// untouched, and the vision model is used for nothing else: it's a reader, not a participant.

// Generous because vision prefill is slow on local hardware: a full-screen capture is a few
// thousand image tokens on top of the encoder pass, and a model server emits nothing at all
// until prefill ends — the same silence a hung server produces (see provider/dispatcher.ts).
export const VISION_TIMEOUT_MS = 300_000;

// One prompt for every image. The consumer is a coding model that cannot see, so exact text
// (errors, code, logs) matters more than prose, and a preamble would just be a token tax.
export const VISION_PROMPT =
  'Describe this image for a coding assistant that cannot see it. ' +
  'First transcribe all visible text exactly — code, error messages, logs, terminal output, ' +
  'UI labels — preserving line breaks and indentation. ' +
  'Then, only if it matters, briefly describe what is shown (layout, diagram, highlighted region). ' +
  'Plain text only, no preamble.';

export type VisionSettings = { model: string; baseURL: string; apiKey: string };

// Data URLs need a MIME type, and the bytes are the only reliable source of one: clipboard
// captures are always PNG, but a dragged-in file can be anything the mention regex admits.
export function sniffImageMime(bytes: Uint8Array): string {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  )
    return 'image/tiff';
  return 'image/png';
}

// The request body, split out so tests can pin the wire shape without a server: OpenAI's
// multimodal user message — a text part and an `image_url` part carrying a base64 data URL —
// which llama.cpp (mtmd), Ollama, vLLM and the cloud providers all accept as-is.
export function visionRequest(model: string, image: Uint8Array): Record<string, unknown> {
  const dataUrl = `data:${sniffImageMime(image)};base64,${Buffer.from(image).toString('base64')}`;
  return {
    model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };
}

// Pure and exported for tests: every way the response can come back — a plain string, an array
// of content parts (some servers echo the multimodal shape), nothing at all — maps to an outcome
// here rather than in the fetch plumbing.
export function parseVisionResponse(body: unknown): OcrOutcome {
  const choice = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0];
  if (!choice || !('message' in choice)) {
    return { ok: false, reason: 'failed', detail: 'the vision model returned no choices' };
  }
  const content = choice.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map(part =>
              part &&
              typeof part === 'object' &&
              typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
            )
            .join('')
        : '';
  const trimmed = text.trim();
  return trimmed ? { ok: true, text: trimmed } : { ok: false, reason: 'no-text' };
}

// Non-streaming on purpose: there is no live line to feed while the paste spinner runs, and one
// JSON body is one less decoder in the path. Never throws — the paste handler reports outcomes,
// it doesn't catch. 'unavailable' is never returned: a configured vision model is by definition
// available, and a server that can't be reached is a failure the user wants to see.
export function visionOcr(settings: VisionSettings): OcrProvider {
  return async (image: Uint8Array): Promise<OcrOutcome> => {
    const url = `${settings.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const dispatcher = await streamDispatcher();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify(visionRequest(settings.model, image)),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      // undici says "fetch failed" and parks the real reason (ECONNREFUSED…) on `cause`.
      const cause = (e as { cause?: { message?: string } } | null)?.cause?.message;
      const why = cause ?? (e instanceof Error ? e.message : String(e));
      return {
        ok: false,
        reason: 'failed',
        detail: timedOut
          ? `${settings.model} did not answer within ${VISION_TIMEOUT_MS / 1000}s`
          : `could not reach ${settings.model} at ${settings.baseURL}: ${why}`,
      };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        reason: 'failed',
        detail: `${settings.model} returned ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: 'failed', detail: `${settings.model} returned a non-JSON body` };
    }
    return parseVisionResponse(body);
  };
}
