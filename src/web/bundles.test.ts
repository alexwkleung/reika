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
    // Outside the client, the page reaches only src/display/ (the display rules both front ends
    // draw by; display.test.ts keeps that directory Ink-, chalk- and Node-free) and these two.
    const outside = inputs.filter(f => f.startsWith('src/') && !f.startsWith('src/web/client/'));
    const BESIDE_DISPLAY = [
      'src/mcp/toolprefix.ts', // the MCP name prefix toolLabel reads
      'src/web/protocol.ts', // PROTOCOL_VERSION; its one value import is display/pastes.ts
    ];
    expect(
      outside.filter(f => !f.startsWith('src/display/') && !BESIDE_DISPLAY.includes(f)),
    ).toEqual([]);
    expect(result.metafile.inputs['src/web/protocol.ts']!.imports.map(i => i.path)).toEqual([
      'src/display/pastes.ts',
    ]);
    expect(result.metafile.inputs['src/display/pastes.ts']!.imports).toEqual([]);
    const imported = outside.flatMap(f => result.metafile.inputs[f]!.imports.map(i => i.path));
    expect(
      imported.filter(
        p =>
          !p.startsWith('src/') &&
          // `diff` is jsdiff, pure JS: intraline.ts pairs words with it.
          !/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(react|diff)\//.test(p),
      ),
    ).toEqual([]);
  });
});
