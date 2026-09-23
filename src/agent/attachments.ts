import type { OcrOutcome } from '../ocr/types.js';

// Pasted-image attachments. A clipboard image is OCR'd the moment it's pasted and parked here
// keyed by a short marker (`[Image 1]`) that goes into the input buffer in its place — the user
// sees a token they can move or delete, not a wall of extracted text, and the marker survives
// into the scrollback bubble as a readable record of what was attached.

// Extracted text is capped well below the mention cap (50k): a dense screenshot can OCR into
// thousands of characters, and this tool's whole premise is that context is scarce.
export const MAX_IMAGE_TEXT = 20_000;

// Under a native-vision profile (`VisionRoute`) the bytes are never read: they go to the model as
// an image part for the turn that attached them, and this note takes the description's place in
// history. Written to be true *after* the fact — by the time the model reads it again the image is
// long gone, and the honest thing to say is that it can no longer look.
export const NATIVE_IMAGE_NOTE =
  '(not transcribed — you were shown this image directly, once. ' +
  'Ask for a re-paste if you need to look at it again.)';

export type ImageAttachment = {
  marker: string;
  text: string;
  // What the image came from, surfaced to the model as the block's `source` attribute.
  source: string;
  // Held only under a native-vision profile: sent to the model by the turn that attaches it, then
  // dropped with the attachment (the ref is cleared the moment a turn sends), so an image reaches
  // the model exactly once and is never re-sent.
  native?: NativeImageBytes;
};

export type NativeImageBytes = {
  bytes: Uint8Array;
  mime: string;
};

// Those bytes stamped with the marker of the attachment they belong to — the link that ties an
// image to the single history user message the user pasted it into, so a marker deleted from the
// input takes its bytes with it. See provider/toolcall.ts for where they land in the request.
export type NativeImage = NativeImageBytes & { marker: string };

const MARKER_RE = /\[Image (\d+)\]/g;

export function nextImageMarker(existing: ImageAttachment[]): string {
  const used = existing.map(a => Number(/\d+/.exec(a.marker)?.[0] ?? 0));
  return `[Image ${Math.max(0, ...used) + 1}]`;
}

// The model-facing form of extracted text. Mirrors the <file> block expandMentions emits, so
// an image reads as one more attached artifact rather than a new concept to learn.
export function imageBlock(attrs: Record<string, string>, text: string): string {
  const rendered = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
    .join('');
  return `<image${rendered}>\n${truncateImageText(text)}\n</image>`;
}

export function truncateImageText(text: string): string {
  if (text.length <= MAX_IMAGE_TEXT) return text;
  return (
    text.slice(0, MAX_IMAGE_TEXT) + `\n…(truncated, ${text.length - MAX_IMAGE_TEXT} more chars)`
  );
}

// Prepend a block for every attachment still referenced in the text. An attachment whose marker
// the user deleted while editing is dropped: the marker is the user's handle on the attachment,
// so removing it has to mean "don't send this".
export function attachImageBlocks(input: string, attachments: ImageAttachment[]): string {
  const live = attachments.filter(a => input.includes(a.marker));
  if (live.length === 0) return input;
  const blocks = live.map(a =>
    imageBlock({ id: /\d+/.exec(a.marker)?.[0] ?? '1', source: a.source }, a.text),
  );
  return `${blocks.join('\n\n')}\n\n${input}`;
}

// A native attachment's route is chosen at paste time, but the turn that sends it can run on a
// profile that cannot see — a /model switch in between, or a queued message replayed after one.
// Its bytes would then reach a text-only model, and history would hold only NATIVE_IMAGE_NOTE. So
// the sending turn reads them first, the way the describe route would have at paste time.
export async function readNativeAttachments(
  attachments: ImageAttachment[],
  ocr: (bytes: Uint8Array) => Promise<OcrOutcome>,
): Promise<{ attachments: ImageAttachment[]; failed: string[] }> {
  const failed: string[] = [];
  const read = await Promise.all(
    attachments.map(async (a): Promise<ImageAttachment> => {
      if (!a.native) return a;
      const result = await ocr(a.native.bytes);
      if (result.ok) return { marker: a.marker, text: result.text, source: a.source };
      failed.push(a.marker);
      return { marker: a.marker, text: '(image could not be read)', source: a.source };
    }),
  );
  return { attachments: read, failed };
}

// Whether any marker at all is present — lets the caller skip the work when nothing was pasted.
export function hasImageMarker(input: string): boolean {
  MARKER_RE.lastIndex = 0;
  return MARKER_RE.test(input);
}
