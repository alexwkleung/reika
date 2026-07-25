import type { OcrOutcome, OcrProvider } from './types.js';

// Shape of @napi-rs/system-ocr's `recognize`. Declared locally rather than imported as a type
// because the package is an optional dependency — on a platform with no prebuilt binary it is
// absent entirely, and a type-only import would still make tsc demand it be installed.
type SystemOcrModule = {
  recognize(
    image: string | Uint8Array,
    accuracy?: number | null,
    preferredLangs?: string[] | null,
    signal?: AbortSignal | null,
  ): Promise<{ text: string; confidence: number }>;
};

// `null` caches "no binary for this platform" so a Linux user pressing ctrl-v repeatedly
// doesn't re-attempt a failing import each time. `undefined` means "not tried yet".
let cached: SystemOcrModule | null | undefined;

// Must stay lazy. The package's entry point throws on import when no platform binary matched
// (npm skips the non-matching optionalDependencies), so a top-level import would take the
// whole CLI down on Linux rather than degrading to "image paste unavailable".
async function load(): Promise<SystemOcrModule | null> {
  if (cached !== undefined) return cached;
  try {
    cached = (await import('@napi-rs/system-ocr')) as unknown as SystemOcrModule;
  } catch {
    cached = null;
  }
  return cached;
}

// Exported for tests, which need each case to start from a clean probe.
export function resetSystemOcrCache(): void {
  cached = undefined;
}

// macOS Vision / Windows.Media.Ocr. Model-agnostic by construction: the model never sees the
// image, only the text, so a text-only local model handles a pasted screenshot exactly as
// well as a vision one.
export function systemOcr(langs?: string[]): OcrProvider {
  return async (image: Uint8Array): Promise<OcrOutcome> => {
    const mod = await load();
    if (!mod) return { ok: false, reason: 'unavailable' };
    return recognizeWith(mod, image, langs);
  };
}

// Split from systemOcr so the outcome mapping is testable with a stub module — the real one is
// an optional dependency that simply isn't installed on a platform without a prebuilt binary.
export async function recognizeWith(
  mod: SystemOcrModule,
  image: Uint8Array,
  langs?: string[],
): Promise<OcrOutcome> {
  try {
    // `confidence` is deliberately ignored: it reads ~0.44 on text that came back
    // character-perfect, so any threshold would reject good extractions.
    const result = await mod.recognize(image, null, langs && langs.length > 0 ? langs : null);
    const text = result.text.trim();
    return text ? { ok: true, text } : { ok: false, reason: 'no-text' };
  } catch (e) {
    // An image with nothing readable in it throws rather than returning empty text.
    const detail = (e as Error).message ?? String(e);
    if (/no text recognized/i.test(detail)) return { ok: false, reason: 'no-text' };
    return { ok: false, reason: 'failed', detail };
  }
}
