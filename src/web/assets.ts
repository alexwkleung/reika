import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebAsset } from './server.js';

// The proof client's files (#584, `web` branch only). An allowlist rather than a directory: the
// request path is only ever a key, never joined onto `root`.
const PROOF_FILES: ReadonlyMap<string, { file: string; contentType: string }> = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/client.js', { file: 'client.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', contentType: 'text/css; charset=utf-8' }],
]);

// Read per request, so an edit to the client shows on reload without a restart.
export function proofAssets(root: string): (pathname: string) => Promise<WebAsset | null> {
  return async pathname => {
    const entry = PROOF_FILES.get(pathname);
    if (!entry) return null;
    try {
      return { body: await readFile(join(root, entry.file)), contentType: entry.contentType };
    } catch {
      return null;
    }
  };
}
