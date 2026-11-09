#!/usr/bin/env node
// Bundles src/ into dist/ with esbuild. One file per entry plus shared chunks, all flat in dist/,
// so `import.meta.url` in any of them is one level under the package root (version.ts relies on it).
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

const result = await build({
  entryPoints: ['src/cli.tsx'],
  outdir: 'dist',
  bundle: true,
  // Splitting keeps the lazy imports lazy: --version loads neither front-end, headless never loads
  // Ink, and the page extractor loads on the first fetch.
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  entryNames: '[name]',
  chunkNames: '[name]-[hash]',
  // The OCR binary is resolved and loaded by a child process, never by reika (see ocr/system.ts).
  external: ['@napi-rs/system-ocr'],
  // React and Ink's reconciler pick a build from NODE_ENV; fixed here, the development ones are
  // dropped from the bundle and nothing has to set the variable at runtime.
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      // Ink imports this under DEV=true, and it needs react-devtools-core, which reika does not ship.
      name: 'drop-ink-devtools',
      setup(b) {
        b.onLoad({ filter: /ink[\\/]build[\\/]devtools\.js$/ }, () => ({ contents: '' }));
      },
    },
  ],
  // Bundled CommonJS dependencies call `require` for node built-ins, which ESM output lacks.
  banner: {
    js: "import { createRequire as __reikaCreateRequire } from 'node:module';\nconst require = __reikaCreateRequire(import.meta.url);",
  },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

chmodSync('dist/cli.js', 0o755);

// The bundle carries its dependencies' code, so their license texts ship beside it.
const packageDirs = new Set();
for (const path of Object.keys(result.metafile.inputs)) {
  const at = path.lastIndexOf('node_modules/');
  if (at === -1) continue;
  const name = path.slice(at + 13).match(/^(?:@[^/]+\/)?[^/]+/)[0];
  packageDirs.add(path.slice(0, at + 13) + name);
}
const notices = [...packageDirs]
  .map(dir => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir).find(f => /^(licen[sc]e|copying)/i.test(f));
    if (!file && !pkg.license) throw new Error(`no license found for ${pkg.name}`);
    const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${pkg.license}`;
    return { key: `${pkg.name}@${pkg.version}`, text };
  })
  .sort((a, b) => a.key.localeCompare(b.key));
writeFileSync(
  'dist/THIRD_PARTY_LICENSES.txt',
  'reika bundles the following packages.\n\n' +
    notices.map(n => `${'-'.repeat(72)}\n${n.key}\n\n${n.text}\n`).join('\n'),
);

if (process.argv.includes('--report')) {
  const sizes = new Map();
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    const m = path.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
    const key = m ? m[1] : 'reika';
    sizes.set(key, (sizes.get(key) ?? 0) + input.bytes);
  }
  for (const [name, bytes] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`${(bytes / 1024).toFixed(0).padStart(7)} KB  ${name}`);
  for (const [path, out] of Object.entries(result.metafile.outputs))
    console.log(`${(out.bytes / 1024).toFixed(0).padStart(7)} KB  ${path}`);
}
