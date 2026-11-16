// Records a raw take of the web demo: the same task as docs/demo.tape, driven in `reika web` instead
// of the terminal. Start your model server, then run from the repo root:
//   node docs/demo-web.mjs
// It prints the turn's end in seconds and the cut command, which writes docs/demo-web.gif:
//   scripts/demo-cut.sh <turn-end-seconds> /tmp/reika-demo-web-raw.mkv 3 docs/demo-web.gif
//
// Runs this checkout's source (`reika web` is not on npm yet); REIKA_DEMO_BIN=reika runs the
// installed one instead. REIKA_DEMO_MODEL=<id> picks the model, as for the tape.
// Each run copies docs/demo/project to /tmp/reika-demo-web with a git baseline, as the tape does, and
// runs under a temp HOME holding only a copy of ~/.config/reika/.env: the history pane lists the
// sessions under HOME, and the take must not show yours. Headless Chrome (or REIKA_CHROME_PATH)
// draws the page at the tape's 1280x760; its screencast frames are laid out on a constant 12 fps
// timeline and written losslessly, so the cut is the only step that touches colour.
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT =
  'withRetry in src/fetch.js never backs off, make it exponential and add a test for the delays';
const WIDTH = 1280;
const HEIGHT = 760;
const FPS = 12;
const TYPING_MS = 45; // the tape's TypingSpeed
const HOLD_MS = 6_000; // recorded past the turn's end, for the cut's hold
const TURN_TIMEOUT_MS = 30 * 60_000;
const OUT = process.env.REIKA_DEMO_OUT ?? join(tmpdir(), 'reika-demo-web-raw.mkv');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'reika-demo-web-'));
// A short fixed path, as the tape's /tmp/reika-demo: the status strip and the sandbox note show it.
const project = '/tmp/reika-demo-web';
const home = join(work, 'home');
const frames = join(work, 'frames');
const children = [];
let failed = false;

// Both children write under `work` as they exit (Chrome's profile, reika's save), so wait for them.
async function cleanup() {
  await Promise.all(
    children.map(
      child =>
        new Promise(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', resolve);
          child.kill();
          setTimeout(() => (child.kill('SIGKILL'), resolve()), 5_000).unref();
        }),
    ),
  );
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

try {
  rmSync(project, { recursive: true, force: true });
  cpSync(join(ROOT, 'docs/demo/project'), project, { recursive: true });
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['commit', '-qm', 'init'],
  ]) {
    spawnSync('git', args, { cwd: project, stdio: 'ignore' });
  }
  mkdirSync(join(home, '.config/reika'), { recursive: true });
  mkdirSync(frames);
  const env = join(homedir(), '.config/reika/.env');
  if (existsSync(env)) copyFileSync(env, join(home, '.config/reika/.env'));

  // 1. reika web, under the temp HOME.
  const bin = process.env.REIKA_DEMO_BIN;
  const command = bin
    ? [bin, ['web']]
    : [
        join(ROOT, 'node_modules/.bin/tsx'),
        ['--tsconfig', join(ROOT, 'tsconfig.json'), join(ROOT, 'src/cli.tsx'), 'web'],
      ];
  let output = '';
  const reika = spawn(command[0], command[1], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      REIKA_DEFAULT_MODE: 'agent',
      ...(process.env.REIKA_DEMO_MODEL ? { REIKA_MODEL: process.env.REIKA_DEMO_MODEL } : {}),
    },
  });
  children.push(reika);
  reika.stdout.on('data', d => (output += d));
  reika.stderr.on('data', d => (output += d));
  let link;
  for (let i = 0; i < 240 && !link; i++) {
    link = output.match(/http:\/\/127\.0\.0\.1:\d+\/#code=\S+/)?.[0];
    if (!link) await sleep(250);
  }
  if (!link) throw new Error(`reika web printed no link:\n${output}`);

  // 2. Headless Chrome at the tape's size.
  const chromePath =
    process.env.REIKA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile = join(work, 'chrome');
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--hide-scrollbars',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  children.push(chrome);
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      await sleep(100);
    }
  }
  if (!port) throw new Error('Chrome never opened its DevTools port');
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
    t => t.type === 'page',
  );
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const shots = [];
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = msg.params;
      const at = metadata.timestamp * 1000;
      const file = join(frames, `${String(shots.length).padStart(6, '0')}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      shots.push({ file, at });
      ws.send(
        JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId } }),
      );
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
  };
  const evaluate = async expression => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (what, expression, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await evaluate(expression)) return;
      await sleep(250);
    }
    throw new Error(`never saw ${what}:\n${await evaluate('document.body.innerText')}`);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 3. Sign in, then record from the empty page on, as the tape's take starts at the prompt.
  await cdp('Page.navigate', { url: link });
  await waitFor('a session', `!!document.querySelector('.status-strip')`, 60_000);
  await sleep(1_000);
  const started = Date.now();
  await cdp('Page.startScreencast', { format: 'png', maxWidth: WIDTH, maxHeight: HEIGHT });
  await sleep(1_000);
  await evaluate(`document.querySelector('textarea.composer-input').focus()`);
  for (const ch of PROMPT) {
    await cdp('Input.insertText', { text: ch });
    await sleep(TYPING_MS);
  }
  await sleep(500);
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r' } : {}),
    });
  }

  // 4. The turn ends on the same line the terminal take is cut at.
  await waitFor(
    'the turn to end',
    `document.body.innerText.includes('Worked for')`,
    TURN_TIMEOUT_MS,
  );
  const turnEnd = (Date.now() - started) / 1000;
  await sleep(HOLD_MS);
  await cdp('Page.stopScreencast');
  await sleep(300);
  ws.close();
  if (shots.length === 0) throw new Error('the screencast sent no frames');

  // 5. A constant-rate timeline: each frame holds until the next one's timestamp. Screencast sends
  // a frame only when the page changes, so a still stretch is one frame held long.
  const first = shots[0].at;
  const lines = [];
  shots.forEach((s, i) => {
    const next = shots[i + 1]?.at ?? s.at + 1000 / FPS;
    lines.push(`file '${s.file}'`, `duration ${Math.max(0.001, (next - s.at) / 1000).toFixed(3)}`);
  });
  lines.push(`file '${shots.at(-1).file}'`);
  const list = join(work, 'frames.txt');
  writeFileSync(list, lines.join('\n') + '\n');
  const offset = (first - started) / 1000;
  const ff = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `fps=${FPS}`,
      '-c:v',
      'ffv1',
      OUT,
    ],
    { stdio: 'inherit' },
  );
  if (ff.status !== 0) throw new Error('ffmpeg could not write the take');
  const end = Math.max(0, turnEnd - offset).toFixed(1);
  console.log(`wrote ${OUT} (${shots.length} frames)`);
  console.log(`turn ended at ${end}s; cut it with:`);
  console.log(`  scripts/demo-cut.sh ${end} ${OUT} 3 docs/demo-web.gif`);
} catch (err) {
  failed = true;
  console.error(String(err?.message ?? err));
} finally {
  await cleanup();
  process.exit(failed ? 1 : 0);
}
