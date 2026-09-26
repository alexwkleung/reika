import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read version from package.json at module load. Works in both src/ (tsx) and dist/.
let version = '0.0.0';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (pkg.version) version = pkg.version;
} catch {
  // fall back to default
}

export const VERSION = version;

// The reference docs ship with the install (package.json has no `files` field), so the model can
// read reika's own behavior instead of guessing it (#531). Null when absent, so the prompt names
// nothing that is not there.
const docsDir = join(packageRoot, 'docs');
export const DOCS_DIR: string | null = existsSync(docsDir) ? docsDir : null;

// Sent on every outbound request so reika identifies itself by name rather than as undici's
// default `node` — the generic-library fingerprint that bot filters deny and that API providers
// (OpenCode Go states it outright) ask clients not to use. Two shapes: a bare product token for
// API calls, and the `Mozilla/5.0 (compatible; …)` crawler convention for web pages, which tells
// a site "a bot that renders modern HTML" without pretending to be a browser.
export const API_USER_AGENT = `reika/${VERSION}`;
export const WEB_USER_AGENT = `Mozilla/5.0 (compatible; reika/${VERSION})`;
