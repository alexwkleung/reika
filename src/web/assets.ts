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

// The built browser client (scripts/build-web.mjs writes these into dist/web/).
const CLIENT_FILES: ReadonlyMap<string, { file: string; contentType: string }> = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', contentType: 'text/css; charset=utf-8' }],
  // Same-origin, so the page's CSP (default-src 'self') needs no data: exception for it.
  ['/favicon.svg', { file: 'favicon.svg', contentType: 'image/svg+xml' }],
]);

export const CLIENT_NOT_BUILT =
  'The reika web client has not been built. Run `pnpm run build:web` and reload.\n';

type Assets = (pathname: string) => Promise<WebAsset | null>;

// Read per request, so a rebuild or an edit shows on reload without a restart.
function servedFrom(files: typeof PROOF_FILES, root: string): Assets {
  return async pathname => {
    const entry = files.get(pathname);
    if (!entry) return null;
    try {
      return { body: await readFile(join(root, entry.file)), contentType: entry.contentType };
    } catch {
      return null;
    }
  };
}

export function proofAssets(root: string): Assets {
  return servedFrom(PROOF_FILES, root);
}

// From source the build is a separate step, so a missing page says which one rather than 404.
export function clientAssets(root: string): Assets {
  const serve = servedFrom(CLIENT_FILES, root);
  return async pathname => {
    const asset = await serve(pathname);
    if (asset || pathname !== '/') return asset;
    return { body: CLIENT_NOT_BUILT, contentType: 'text/plain; charset=utf-8' };
  };
}
