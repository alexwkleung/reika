import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exitAfterDrain } from './drainexit.js';

const HELPER = fileURLToPath(new URL('./drainexit.ts', import.meta.url));
const BYTES = 200_000;

// The child's stdout is a pipe here, the shape `-p --json | jq` and a harness's capture_output have.
function pipedByteCount(drain: boolean): Promise<number> {
  const script = [
    `import { exitAfterDrain } from ${JSON.stringify(HELPER)};`,
    `process.stdout.write('x'.repeat(${BYTES}));`,
    drain ? 'await exitAfterDrain(0);' : 'process.exit(0);',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let count = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      count += chunk.length;
    });
    child.on('error', reject);
    child.on('close', () => resolve(count));
  });
}

describe('exitAfterDrain', () => {
  it('delivers output past the 64 KiB pipe buffer before exiting (#1060)', async () => {
    expect(await pipedByteCount(true)).toBe(BYTES);
  });

  // The control: proves the child above exercises the bug. Pipes are synchronous on Linux.
  it.skipIf(process.platform !== 'darwin')('a bare exit loses it on macOS', async () => {
    expect(await pipedByteCount(false)).toBeLessThan(BYTES);
  });

  it('exits only after every stream has called back', async () => {
    const callbacks: Array<() => void> = [];
    const stream = { write: (_: string, cb: () => void) => void callbacks.push(cb) };
    const exits: number[] = [];
    const done = exitAfterDrain(3, [stream, stream], c => exits.push(c));
    await Promise.resolve();
    expect(exits).toEqual([]);
    callbacks[0]();
    await Promise.resolve();
    expect(exits).toEqual([]);
    callbacks[1]();
    await done;
    expect(exits).toEqual([3]);
  });

  it('exits anyway when a reader stops draining', async () => {
    const stuck = { write: () => true };
    const exits: number[] = [];
    await exitAfterDrain(1, [stuck], c => exits.push(c), 10);
    expect(exits).toEqual([1]);
  });

  it('exits when a stream is already destroyed', async () => {
    const destroyed = {
      write: () => {
        throw new Error('write after end');
      },
    };
    const exits: number[] = [];
    await exitAfterDrain(0, [destroyed], c => exits.push(c), 1000);
    expect(exits).toEqual([0]);
  });
});

describe('exitAfterDrain with a closed reader', () => {
  it('exits cleanly when the reader closes the pipe early', async () => {
    const script = [
      `import { exitAfterDrain } from ${JSON.stringify(HELPER)};`,
      `process.stdout.write('line\\n'.repeat(50000));`,
      'await exitAfterDrain(0);',
    ].join('\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.stdout.once('data', () => child.stdout.destroy());
      child.on('error', reject);
      child.on('close', c => (c === 0 ? resolve(c) : reject(new Error(`exit ${c}: ${stderr}`))));
    });
    expect(code).toBe(0);
  });
});
