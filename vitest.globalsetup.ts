import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests get a throwaway HOME. `config.ts` loads ~/.config/reika/.env as an import side effect, so
// without this every test ran under the developer's own flags (CI has no such file), and with
// REIKA_DEBUG=1 there each test process wrote a session log into the real logs directory. Workers
// start after this runs and inherit it, as do the CLI processes tests spawn.
export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'reika-test-home-'));
  // The sandbox tests need a directory the profile refuses, and the throwaway HOME is inside temp,
  // which it allows. They read the real one from here (only to assert a write is refused).
  process.env.REIKA_TEST_REAL_HOME = homedir();
  process.env.HOME = home;
  return () => rmSync(home, { recursive: true, force: true });
}
