#!/usr/bin/env node
import { sweepDebugLogs } from './debug.js';
import { exitAfterDrain } from './drainexit.js';
import { sweepStaleSpills } from './tools/_spill.js';
import { USAGE, parseHeadlessArgs } from './headless/headlessargs.js';
import { loadWithProductionReact } from './ui/reactbuild.js';
import { VERSION } from './version.js';

// Lowercase like the command: ps/top/Activity Monitor otherwise list every session as `node`, and
// pgrep/pkill match case-sensitively.
process.title = 'reika';

// Spill directories are removed on a normal exit, but SIGHUP (closing the terminal window),
// SIGTERM, SIGKILL and hard crashes never reach that handler (#224). The sweep is the cleanup
// path for those, and it belongs here rather than in a React effect: it is a property of the
// process starting, not of anything the UI mounts. Fire-and-forget — cleaning up after a session
// that is already gone must never delay first paint, and it fails open on its own.
void sweepStaleSpills();
// Debug-log retention (#761), the same shape: per-session logs past their age or size budget.
void sweepDebugLogs();

// `reika web` (#584) is checked first, since its argv would read as a stray positional to the
// headless parser. Lazily imported like the others, and Ink-free.
let web = null;
if (process.argv[2] === 'web') {
  try {
    const { parseWebArgs } = await import('./web/command.js');
    web = parseWebArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`reika: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
if (web) {
  const { runWeb, terminalLink, WEB_USAGE } = await import('./web/command.js');
  if (web.help) {
    process.stdout.write(`${WEB_USAGE}\n`);
    process.exit(0);
  }
  const { loadConfig } = await import('./config.js');
  const { loadLastState, saveLastState } = await import('./laststate.js');
  const run = await runWeb(web, {
    stdout: text => void process.stdout.write(text),
    stderr: text => void process.stderr.write(text),
    cwd: process.cwd(),
    loadConfig,
    loadLastState,
    saveLastState,
  }).catch((e: Error) => {
    process.stderr.write(`reika: ${e.message}\n`);
    return 1;
  });
  if (typeof run === 'number') process.exit(run);
  // Unlike the TUI (#224), nothing here owns ctrl-c, and default signal death skips the exit hooks
  // that end MCP servers and a running bash group, so the orderly shutdown runs first.
  let signalled = false;
  const onSignal = (code: number) => () => {
    if (signalled) process.exit(code);
    signalled = true;
    void run.shutdown(code);
  };
  // Enter prints a fresh link: the first one works once, and a second tab needs its own.
  if (process.stdin.isTTY) {
    process.stdin.on('data', () => {
      process.stdout.write(`\n  ${terminalLink(run.newLink())}\n\n`);
    });
    // Not a reason to stay alive once the server has shut down.
    process.stdin.unref();
  }
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));
  process.exit(await run.done);
}

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
  await exitAfterDrain(0);
}

if (headless) {
  const { runHeadless, terminalSafeWriter } = await import('./headless/headless.js');
  const code = await runHeadless(headless, {
    stdout: terminalSafeWriter(process.stdout),
    stderr: terminalSafeWriter(process.stderr),
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
  await exitAfterDrain(code);
} else {
  const { startTui } = await loadWithProductionReact(() => import('./ui/tui.js'));
  startTui();
}
