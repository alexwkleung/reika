import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// A screenshot pasted as hex through a pipe is ~2× its byte size; generous so a large
// retina capture can't silently truncate.
const MAX_BUFFER = 128 * 1024 * 1024;

// The terminal never hands us image bytes — a paste is always text — so reading the system
// clipboard ourselves is the only way in. Platform-gated rather than dependency-backed:
// every OS ships something that can do this, and none of them are worth an npm package.
export function clipboardImageSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

// Encoded PNG bytes from the clipboard, or null when it holds no image (text, files, empty).
// Never throws for the ordinary "no image there" case — that's a normal ctrl-v outcome.
export async function readClipboardImage(): Promise<Buffer | null> {
  if (process.platform === 'darwin') return readDarwin();
  if (process.platform === 'win32') return readWin32();
  return null;
}

// AppleScript returns the data inline as «data PNGf89504E47…», so this is one subprocess with
// no temp file to clean up and no half-written file to handle on error. Costs a hex round-trip
// (~350ms for 67KB), which beats the bookkeeping of the write-to-file variant.
async function readDarwin(): Promise<Buffer | null> {
  try {
    const { stdout } = await run('osascript', ['-e', 'get the clipboard as «class PNGf»'], {
      maxBuffer: MAX_BUFFER,
    });
    return parseAppleScriptData(stdout);
  } catch {
    // Coercion fails when the clipboard holds anything that isn't an image.
    return null;
  }
}

// Windows PowerShell rather than pwsh: System.Windows.Forms.Clipboard needs the .NET Framework
// assemblies that only Windows PowerShell 5.1 is guaranteed to have, and -STA because the
// clipboard API refuses to run on an MTA thread. Writes to a temp file instead of stdout —
// PowerShell mangles binary on the way out.
async function readWin32(): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'reika-clip-'));
  const out = join(dir, 'clip.png');
  try {
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
          `$img = [System.Windows.Forms.Clipboard]::GetImage(); ` +
          `if ($null -eq $img) { exit 3 }; ` +
          `$img.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      ],
      { maxBuffer: MAX_BUFFER },
    );
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Pulls the bytes out of AppleScript's «data PNGf…» literal. Exported for tests: the osascript
// call itself needs a real clipboard, but this parse is where the format assumptions live.
export function parseAppleScriptData(stdout: string): Buffer | null {
  // \w{4} is the type code (PNGf, TIFF, …); whitespace is stripped from the hex body only,
  // since osascript is free to wrap a long literal across lines.
  const match = /«data \w{4}([0-9A-Fa-f\s]*)»/.exec(stdout);
  if (!match) return null;
  const bytes = Buffer.from(match[1].replace(/\s+/g, ''), 'hex');
  return bytes.length > 0 ? bytes : null;
}
