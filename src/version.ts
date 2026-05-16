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
