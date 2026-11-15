import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebAsset } from './server.js';

// The built browser client (scripts/build-web.mjs writes these into dist/web/). An allowlist rather
// than a directory: the request path is only ever a key, never joined onto `root`.
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

// Read per request, so a rebuild shows on reload without a restart.
function servedFrom(root: string): Assets {
  return async pathname => {
    const entry = CLIENT_FILES.get(pathname);
    if (!entry) return null;
    try {
      return { body: await readFile(join(root, entry.file)), contentType: entry.contentType };
    } catch {
      return null;
    }
  };
}

// From source the build is a separate step, so a missing page says which one rather than 404.
export function clientAssets(root: string): Assets {
  const serve = servedFrom(root);
  return async pathname => {
    const asset = await serve(pathname);
    if (asset || pathname !== '/') return asset;
    return { body: CLIENT_NOT_BUILT, contentType: 'text/plain; charset=utf-8' };
  };
}
