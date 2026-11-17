// A write to a pipe is asynchronous on macOS, and process.exit drops whatever is still queued past
// the pipe buffer: `-p --json | jq` lost everything after byte 65,536 (#1060). An empty write's
// callback fires once the writes queued before it have flushed, so waiting on it completes the
// output while the explicit exit still ends a run a stray handle (an MCP server, a bash group)
// would keep alive.
export const DRAIN_TIMEOUT_MS = 5000;

type DrainableStream = { write: (chunk: string, cb: (err?: Error | null) => void) => unknown };

export function drainStream(stream: DrainableStream): Promise<void> {
  return new Promise(resolve => {
    try {
      stream.write('', () => resolve());
    } catch {
      // A destroyed stream throws instead of calling back; there is nothing left to flush.
      resolve();
    }
  });
}

// Bounded because a reader that stops reading without closing the pipe would hold the drain
// forever, which is the hang the explicit exit exists to prevent.
export async function exitAfterDrain(
  code: number,
  streams: DrainableStream[] = [process.stdout, process.stderr],
  exit: (code: number) => void = c => process.exit(c),
  timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(streams.map(drainStream)), timeout]);
  clearTimeout(timer);
  exit(code);
}
