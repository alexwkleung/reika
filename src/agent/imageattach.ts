import type { Config } from '../types.js';
import { imageReader, pasteIsNative } from '../ocr/select.js';
import { systemOcr } from '../ocr/system.js';
import { sniffImageMime } from '../ocr/vision.js';
import { NATIVE_IMAGE_NOTE, type NativeImageBytes } from './attachments.js';

// The image bytes a front end got hold of (a clipboard paste, a page upload), read for the turn
// the way every front end reads them (#49, #979): native bytes under a profile that can see, else
// the vision model or system OCR. The marker is the front end's, so it is not chosen here.
export type ImageRead =
  | {
      ok: true;
      text: string;
      native?: NativeImageBytes;
      // The receipt's tail: `Attached [Image 1] — <detail>.`
      detail: string;
    }
  | { ok: false; notice: string };

// What is running, for a front end that narrates the wait: a local vision model can take a minute
// on a full-screen capture, and "Extracting text" would read as a hang.
export function imageReadLabel(config: Config | null): string | null {
  if (config && pasteIsNative(config)) return null;
  return config?.visionModel ? `Describing image with ${config.visionModel}` : 'Extracting text';
}

// `config` is the ACTIVE profile's, resolved: REIKA_<NAME>_VISION is per profile. Null before the
// config loads, which still gets the platform recognizer. `origin` names the bytes in a receipt.
export async function readImageAttachment(
  bytes: Uint8Array,
  config: Config | null,
  origin: string,
): Promise<ImageRead> {
  // Native vision: nothing is read or described, the bytes ride with the turn and
  // NATIVE_IMAGE_NOTE is what history keeps in their place.
  if (config && pasteIsNative(config)) {
    return {
      ok: true,
      text: NATIVE_IMAGE_NOTE,
      native: { bytes, mime: sniffImageMime(bytes) },
      detail: `sent to ${config.model} as an image`,
    };
  }
  const result = await (config ? imageReader(config) : systemOcr())(bytes);
  if (!result.ok) {
    return {
      ok: false,
      notice:
        result.reason === 'unavailable'
          ? 'Image paste needs system OCR — macOS and Windows only.'
          : result.reason === 'no-text'
            ? 'No text found in the pasted image.'
            : `Couldn't read the pasted image: ${result.detail ?? 'OCR failed'}`,
    };
  }
  const vision = config?.visionModel;
  return {
    ok: true,
    text: result.text,
    detail: vision
      ? `${result.text.length} chars described by ${vision}`
      : `${result.text.length} chars read from the ${origin}`,
  };
}
