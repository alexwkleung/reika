import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { OcrOutcome, OcrProvider } from './types.js';

// Recognition runs in a throwaway child process, not in ours.
//
// Not defensiveness for its own sake: macOS 26's `RecognizeDocumentsRequest` path can fault
// outright on some images. An observed crash (issue #49 follow-up) was a KERN_PROTECTION_FAILURE
// on the stack guard page of a `com.apple.root.default-qos.cooperative` thread, inside Apple's
// own Swift frames — Vision → librecognize_documents `formatDocument`/`allLineIDs`. A memory
// fault is not a JS exception: no try/catch can survive it, and in-process it takes the whole
// TUI (and the user's conversation) down with it. Out of process, the same fault kills a child
// we can afford to lose and comes back as a 'failed' outcome.
//
// Costs one node startup (~50ms) per paste, against a ~530ms clipboard+OCR round trip.

// Kill a recognizer that neither returns nor dies on its own, so a wedged child can't leave the
// paste spinner running forever.
const WORKER_TIMEOUT_MS = 20_000;

// Runs under `node -e`, so it's CJS and `require` is available. Reads image bytes from stdin and
// writes a single JSON envelope to **fd 3**, not stdout: the native library prints its own
// diagnostics to both stdout ("VTEST: error: perform(_:)…") and stderr, which would corrupt the
// envelope — and, in-process, would have corrupted the Ink frame. A private fd is the only
// channel the library can't scribble on. stdin is always drained before anything else can fail,
// so the parent's write can never hit EPIPE against a child that gave up early.
const WORKER = `
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  const out = o => require('fs').writeSync(3, JSON.stringify(o));
  let mod;
  try {
    mod = require(process.env.__REIKA_OCR_MODULE);
  } catch {
    // Package present but no prebuilt binary for this platform (Linux).
    out({ error: 'unavailable' });
    return;
  }
  try {
    const raw = process.env.__REIKA_OCR_LANGS;
    const langs = raw ? JSON.parse(raw) : null;
    const result = await mod.recognize(Buffer.concat(chunks), null, langs);
    out({ text: result.text });
  } catch (e) {
    out({ error: String((e && e.message) || e) });
  }
});
`;

// `null` caches "not installed at all", so a Linux user pressing ctrl-v repeatedly doesn't
// re-resolve each time. `undefined` means "not tried yet". Resolving only reads package
// metadata — it never dlopens the binary, so the parent stays clear of the native code entirely.
let resolved: string | null | undefined;

function resolveOcrModule(): string | null {
  if (resolved !== undefined) return resolved;
  try {
    resolved = createRequire(import.meta.url).resolve('@napi-rs/system-ocr');
  } catch {
    resolved = null;
  }
  return resolved;
}

// Exported for tests, which need each case to start from a clean probe.
export function resetSystemOcrCache(): void {
  resolved = undefined;
}

// macOS Vision / Windows.Media.Ocr. Model-agnostic by construction: the model never sees the
// image, only the text, so a text-only local model handles a pasted screenshot exactly as
// well as a vision one.
export function systemOcr(langs?: string[]): OcrProvider {
  return async (image: Uint8Array): Promise<OcrOutcome> => {
    const modulePath = resolveOcrModule();
    if (!modulePath) return { ok: false, reason: 'unavailable' };
    return runRecognizer(modulePath, image, langs);
  };
}

function runRecognizer(
  modulePath: string,
  image: Uint8Array,
  langs?: string[],
): Promise<OcrOutcome> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', WORKER], {
      env: {
        ...process.env,
        __REIKA_OCR_MODULE: modulePath,
        __REIKA_OCR_LANGS: langs && langs.length > 0 ? JSON.stringify(langs) : '',
      },
      // stdout/stderr discarded outright — both carry the library's own chatter, and either
      // one reaching ours would corrupt the Ink frame. fd 3 carries the result.
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
    });

    let envelope = '';
    let settled = false;
    const finish = (outcome: OcrOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'failed', detail: 'text recognition timed out' });
    }, WORKER_TIMEOUT_MS);

    const results = child.stdio[3] as NodeJS.ReadableStream | null;
    results?.setEncoding('utf8');
    results?.on('data', c => (envelope += c));
    // Spawn failure (no node on PATH, EMFILE) — nothing was ever going to be written.
    child.on('error', e => finish({ ok: false, reason: 'failed', detail: e.message }));
    child.on('close', (code, signal) => finish(parseWorkerResult(envelope, code, signal)));

    // Typed as nullable because some stdio slots are 'ignore'; slot 0 is 'pipe', so this is
    // always present in practice — but a missing pipe means the image can never be delivered.
    if (!child.stdin) {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'failed', detail: 'could not send the image to the recognizer' });
      return;
    }
    child.stdin.on('error', () => {
      // The child died before reading the image; `close` reports the real cause.
    });
    child.stdin.end(Buffer.from(image));
  });
}

// Pure, and exported for tests: every way the child can end — clean JSON, a thrown recognizer
// error, no binary, a signal — maps to an outcome here rather than in the spawn plumbing.
export function parseWorkerResult(
  envelope: string,
  code: number | null,
  signal: string | null,
): OcrOutcome {
  const trimmed = envelope.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { text?: string; error?: string };
      if (typeof parsed.text === 'string') {
        // `confidence` is deliberately not consulted: it reads ~0.44 on text that came back
        // character-perfect, so any threshold would reject good extractions.
        const text = parsed.text.trim();
        return text ? { ok: true, text } : { ok: false, reason: 'no-text' };
      }
      if (parsed.error === 'unavailable') return { ok: false, reason: 'unavailable' };
      if (typeof parsed.error === 'string') {
        // An image with nothing readable in it throws rather than returning empty text.
        if (/no text recognized/i.test(parsed.error)) return { ok: false, reason: 'no-text' };
        return { ok: false, reason: 'failed', detail: parsed.error };
      }
    } catch {
      // Fall through to the signal/exit-code reporting below.
    }
  }
  if (signal) {
    // The crash this whole indirection exists for. Naming the signal makes it reportable
    // upstream instead of looking like reika lost the image.
    return {
      ok: false,
      reason: 'failed',
      detail: `the system text recognizer crashed (${signal})`,
    };
  }
  // Deliberately not surfacing the child's stderr here: the library's loudest line is its
  // routine "falling back to VNRecognizeTextRequest" notice, which reads as the cause but isn't.
  return {
    ok: false,
    reason: 'failed',
    detail: `text recognition exited with code ${code ?? 'unknown'}`,
  };
}
