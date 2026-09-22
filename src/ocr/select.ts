import type { Config } from '../types.js';
import { systemOcr } from './system.js';
import type { OcrProvider } from './types.js';
import { visionOcr } from './vision.js';

// Which reader a pasted or dragged-in image goes through. A configured vision model
// (REIKA_VISION_MODEL) wins outright — it's an opt-in, and the reason to set it is that OCR's
// text-only extraction loses whatever the screenshot shows that isn't text. Connection settings
// fall back to the main server the same way subagent settings do, so a vision model served by the
// same router needs one variable, not three.
export function imageReader(config: Config): OcrProvider {
  if (config.visionModel) {
    return visionOcr({
      model: config.visionModel,
      baseURL: config.visionBaseURL ?? config.baseURL,
      apiKey: config.visionApiKey ?? config.apiKey,
    });
  }
  return systemOcr(config.ocrLangs);
}

// Whether a clipboard paste should skip reading altogether and hand the raw bytes to the model as
// an image part, for a profile whose model can already see (`VisionRoute`). This is a property of
// the *paste* path, not of the reader: the paste path owns the bytes at the moment the turn is
// built, which is the only point in the pipeline where image bytes and an outgoing request are
// both in hand. A `@file.png` mention is expanded into the middle of the prompt by
// agent/mentions.ts, which yields text and has nowhere to put bytes — so mentions always read,
// whatever this says. That is a deliberate limit, not an oversight: it keeps the native route to
// one call site, and one place to reason about when bytes are live.
export function pasteIsNative(config: Config): boolean {
  return config.vision === 'native';
}
