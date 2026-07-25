// Pasted-image attachments. A clipboard image is OCR'd the moment it's pasted and parked here
// keyed by a short marker (`[Image 1]`) that goes into the input buffer in its place — the user
// sees a token they can move or delete, not a wall of extracted text, and the marker survives
// into the scrollback bubble as a readable record of what was attached.

// Extracted text is capped well below the mention cap (50k): a dense screenshot can OCR into
// thousands of characters, and this tool's whole premise is that context is scarce.
export const MAX_IMAGE_TEXT = 20_000;

export type ImageAttachment = {
  marker: string;
  text: string;
  // What the image came from, surfaced to the model as the block's `source` attribute.
  source: string;
};

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

// Whether any marker at all is present — lets the caller skip the work when nothing was pasted.
export function hasImageMarker(input: string): boolean {
  MARKER_RE.lastIndex = 0;
  return MARKER_RE.test(input);
}
