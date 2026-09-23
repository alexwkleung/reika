import type { Config } from '../types.js';
import { systemOcr } from './system.js';
import type { OcrProvider } from './types.js';
import { visionOcr } from './vision.js';

// Which reader a pasted or dragged-in image goes through. A configured vision model
// (REIKA_VISION_MODEL) wins outright — it's an opt-in, and the reason to set it is that OCR's
// text-only extraction loses whatever the screenshot shows that isn't text. Connection settings
// fall back to the main server the same way subagent settings do, so a vision model served by the
// same router needs one variable, not three. Callers pass the config resolved onto the active
// profile, which is what makes "the main server" the one the session is on now.
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
