#!/usr/bin/env node
import { sweepStaleSpills } from './tools/_spill.js';
import { USAGE, parseHeadlessArgs } from './headlessargs.js';
import { VERSION } from './version.js';

// Spill directories are removed on a normal exit, but SIGHUP (closing the terminal window),
// SIGTERM, SIGKILL and hard crashes never reach that handler (#224). The sweep is the cleanup
// path for those, and it belongs here rather than in a React effect: it is a property of the
// process starting, not of anything the UI mounts. Fire-and-forget — cleaning up after a session
// that is already gone must never delay first paint, and it fails open on its own.
void sweepStaleSpills();

// Both front-ends are imported lazily: the headless path (#52) never loads Ink, and the TUI
// never loads the headless runner.
let headless;
try {
  headless = parseHeadlessArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`reika: ${(e as Error).message}\n`);
  process.exit(2);
}

// Answered before either front-end loads, so neither needs a model, a config or a terminal — the
// shape a package manager's install check runs them in.
if (headless?.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (headless?.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (headless) {
  const { runHeadless } = await import('./headless.js');
  const code = await runHeadless(headless, {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    readStdin: async () => {
      if (process.stdin.isTTY) {
        process.stderr.write(`reika: -p needs a prompt or piped stdin\n${USAGE}\n`);
        return '';
      }
      let text = '';
      for await (const chunk of process.stdin) text += chunk;
      return text;
    },
  }).catch((e: Error) => {
    // Anything that fails before the turn starts (config, bootstrap, an unknown /skill) — the
    // turn's own failures are already reported inside.
    process.stderr.write(`reika: ${e.message}\n`);
    return 1;
  });
  process.exit(code);
} else {
  const [{ render }, { App }, { createSyncedStdout }] = await Promise.all([
    import('ink'),
    import('./ui/App.js'),
    import('./ui/syncframe.js'),
  ]);
  // Frames go out as one synchronized write each (#345) so a swapped-out process can't leave the
  // terminal painting a half-erased screen between Ink's writes.
  render(<App />, { exitOnCtrlC: false, stdout: createSyncedStdout(process.stdout) });
}
