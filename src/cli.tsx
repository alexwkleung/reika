#!/usr/bin/env node
import { render } from 'ink';
import { App } from './ui/App.js';
import { sweepStaleSpills } from './tools/_spill.js';

// Spill directories are removed on a normal exit, but SIGHUP (closing the terminal window),
// SIGTERM, SIGKILL and hard crashes never reach that handler (#224). The sweep is the cleanup
// path for those, and it belongs here rather than in a React effect: it is a property of the
// process starting, not of anything the UI mounts. Fire-and-forget — cleaning up after a session
// that is already gone must never delay first paint, and it fails open on its own.
void sweepStaleSpills();

render(<App />, { exitOnCtrlC: false });
