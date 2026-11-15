#!/usr/bin/env node
// Bundles the browser client (src/web/client/) into dist/web/. The Node process never imports any
// of it: it only reads these files off disk and serves them (src/web/assets.ts).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'src', 'web', 'client');
const OUT = join(ROOT, 'dist', 'web');

export async function buildWeb() {
  mkdirSync(OUT, { recursive: true });
  const result = await build({
    entryPoints: { app: join(CLIENT, 'main.tsx') },
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    // Fixed names, since index.html and the server's allowlist both name them.
    entryNames: '[name]',
    tsconfig: join(CLIENT, 'tsconfig.json'),
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
    absWorkingDir: ROOT,
  });
  for (const file of ['index.html', 'favicon.svg'])
    copyFileSync(join(CLIENT, file), join(OUT, file));
  return result.metafile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildWeb();
}
