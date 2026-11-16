import { MAX_IMAGE_BYTES, UPLOAD_TYPES, type SubmittedImage } from '../protocol.js';

// Images in the box (#979): each is an `[Image N]` marker in the text and a chip under it. The
// bytes go up as soon as the image arrives, so the chip can say what came out before Enter; the
// line names the uploads its markers stand for.

export type ImageChip = {
  marker: string;
  name: string;
  size: number;
  // `id` once the server has it; `chars` null for bytes a model that can see is sent as they are.
  state:
    | { kind: 'reading' }
    | { kind: 'ready'; id: string; chars: number | null }
    | { kind: 'failed'; error: string };
};

const MARKER_RE = /\[Image (\d+)\]/g;

// Above every marker this tab can see (chips, the box, the history), so a recalled line's old
// `[Image 1]` never shares a string with a new one.
export function nextImageMarker(chips: ImageChip[], seen: string[]): string {
  let max = 0;
  for (const text of [...chips.map(c => c.marker), ...seen]) {
    for (const m of text.matchAll(MARKER_RE)) max = Math.max(max, Number(m[1]));
  }
  return `[Image ${max + 1}]`;
}

// Why a file cannot go up, or null. The server checks again; this only answers before an upload.
export function imageRefusal(file: { type: string; size: number }): string | null {
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) {
    return 'Only PNG, JPEG, WebP and GIF images can be attached.';
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `That image is over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

// What a submit carries: the ready uploads whose marker the text still holds.
export function imagesFor(text: string, chips: ImageChip[]): SubmittedImage[] {
  return chips.flatMap(c =>
    c.state.kind === 'ready' && text.includes(c.marker)
      ? [{ marker: c.marker, id: c.state.id }]
      : [],
  );
}

export function stillReading(chips: ImageChip[]): boolean {
  return chips.some(c => c.state.kind === 'reading');
}

// The box without a marker, and the space after it that insertion added.
export function withoutMarker(text: string, marker: string): string {
  return text.replace(`${marker} `, '').replace(marker, '');
}

// A chip's line: its name and size, then what came out of it.
export function chipLabel(chip: ImageChip): { name: string; detail: string } {
  const size =
    chip.size >= 1024 * 1024
      ? `${(chip.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(chip.size / 1024))} KB`;
  const detail =
    chip.state.kind === 'reading'
      ? 'Reading…'
      : chip.state.kind === 'failed'
        ? chip.state.error
        : chip.state.chars === null
          ? 'sent as an image'
          : `${chip.state.chars} chars`;
  return { name: `${chip.name} · ${size}`, detail };
}
