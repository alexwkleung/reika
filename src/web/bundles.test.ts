import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The browser client and the Node process share a repo, never a module graph: Node only reads
// dist/web/ off disk, and the page carries no Node code.

const src = join(import.meta.dirname, '..');

describe('bundle boundaries', () => {
  it('the CLI graph loads neither react-dom nor the browser client', async () => {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [join(src, 'cli.tsx')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      packages: 'external',
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter(f => f.includes('src/web/client/'))).toEqual([]);
    const externals = Object.values(result.metafile.inputs).flatMap(f =>
      f.imports.filter(i => i.external).map(i => i.path),
    );
    expect(externals.filter(p => /^react-dom(\/|$)/.test(p))).toEqual([]);
  });

  it('the client bundles for the browser with no Node built-in, no Ink and no Node-side source', async () => {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [join(src, 'web', 'client', 'main.tsx')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      outdir: 'out',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter(f => f.startsWith('node:'))).toEqual([]);
    expect(
      inputs.filter(f => /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?ink\//.test(f)),
    ).toEqual([]);
    const imports = Object.values(result.metafile.inputs).flatMap(f => f.imports.map(i => i.path));
    expect(imports.filter(p => p.startsWith('node:'))).toEqual([]);
    // protocol.ts for PROTOCOL_VERSION: its own imports are all `import type`, so it brings nothing.
    const outside = inputs.filter(f => f.startsWith('src/') && !f.startsWith('src/web/client/'));
    expect(outside).toEqual(['src/web/protocol.ts']);
    expect(result.metafile.inputs['src/web/protocol.ts']!.imports).toEqual([]);
  });
});
