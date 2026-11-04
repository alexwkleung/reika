import { render } from 'ink';
import { App } from './App.js';
import { createSyncedStdout } from './syncframe.js';

export function startTui(): void {
  // Frames go out as one synchronized write each (#345) so a swapped-out process can't leave the
  // terminal painting a half-erased screen between Ink's writes.
  render(<App />, { exitOnCtrlC: false, stdout: createSyncedStdout(process.stdout) });
}
