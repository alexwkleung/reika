import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read version from package.json at module load. Works in both src/ (tsx) and dist/.
let version = '0.0.0';
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (pkg.version) version = pkg.version;
} catch {
  // fall back to default
}

export const VERSION = version;

// Sent on every outbound request so reika identifies itself by name rather than as undici's
// default `node` — the generic-library fingerprint that bot filters deny and that API providers
// (OpenCode Go states it outright) ask clients not to use. Two shapes: a bare product token for
// API calls, and the `Mozilla/5.0 (compatible; …)` crawler convention for web pages, which tells
// a site "a bot that renders modern HTML" without pretending to be a browser.
export const API_USER_AGENT = `reika/${VERSION}`;
export const WEB_USER_AGENT = `Mozilla/5.0 (compatible; reika/${VERSION})`;
