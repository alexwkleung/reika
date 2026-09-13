// Turning an image into text the model can read.
//
// Behind an interface so the two readers — system OCR (system.ts) and a configured vision
// model (vision.ts, #130) — are interchangeable at the call sites. Both yield text: the vision
// model describes the image and the description drops into the same string-only context
// pipeline OCR text does, so the main model never needs multimodal content parts threaded
// through serialization and compaction.
export type OcrOutcome =
  | { ok: true; text: string }
  // 'unavailable' = no OCR on this platform at all (the caller should say so once and stop
  // offering the feature); 'no-text' = ran fine, found nothing readable; 'failed' = the
  // provider errored. The three want different things said to the user, so they stay distinct.
  | { ok: false; reason: 'unavailable' | 'no-text' | 'failed'; detail?: string };

// Takes encoded image bytes (PNG/JPEG/…), not a decoded bitmap — every source we have
// (clipboard, file on disk) already hands us an encoded buffer.
export type OcrProvider = (image: Uint8Array) => Promise<OcrOutcome>;
