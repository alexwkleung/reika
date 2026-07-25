// Turning an image into text the model can read.
//
// Behind an interface because the two ways to do this differ in kind, not degree: system OCR
// yields text that drops straight into the existing string-only context pipeline, while a
// vision model would need multimodal content parts threaded through serialization and
// compaction. Issue #49 wants the second eventually; this shape lets it slot in without
// touching the call sites.
export type OcrOutcome =
  | { ok: true; text: string }
  // 'unavailable' = no OCR on this platform at all (the caller should say so once and stop
  // offering the feature); 'no-text' = ran fine, found nothing readable; 'failed' = the
  // provider errored. The three want different things said to the user, so they stay distinct.
  | { ok: false; reason: 'unavailable' | 'no-text' | 'failed'; detail?: string };

// Takes encoded image bytes (PNG/JPEG/…), not a decoded bitmap — every source we have
// (clipboard, file on disk) already hands us an encoded buffer.
export type OcrProvider = (image: Uint8Array) => Promise<OcrOutcome>;
