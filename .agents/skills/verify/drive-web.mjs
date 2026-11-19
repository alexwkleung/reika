// Drives the `reika web` page in headless Chrome over CDP. Usage:
//   node drive-web.mjs <link> <out-dir> [prompt]
// Signs in with the single-use link, sends a prompt, approves the first approval dialog, waits for
// DRIVE_OK, then screenshots desktop and phone width. Exits 1 with the page's text on
// a step that never happened. Node ships a global WebSocket, so CDP needs no dependency.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [link, out, prompt = 'run a command for me'] = process.argv.slice(2);
if (!link || !out) {
  console.error('usage: node drive-web.mjs <link> <out-dir> [prompt]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const CHROME =
  process.env.REIKA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'reika-drive-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
let seq = 0;
const pending = new Map();

function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(what, expression, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await sleep(150);
  }
  const text = await evaluate('document.body.innerText');
  throw new Error(`never saw ${what}. Page text:\n${text}`);
}
async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, name), Buffer.from(data, 'base64'));
  console.log(`screenshot ${join(out, name)}`);
}

let failed = false;
try {
  // Chrome writes the port it picked here once DevTools is listening.
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      await sleep(100);
    }
  }
  if (!port) throw new Error('Chrome never opened its DevTools port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  await cdp('Page.enable');
  await cdp('Runtime.enable');

  await cdp('Page.navigate', { url: link });
  // The page trades the fragment's code for a token, then opens the event stream. The input box
  // draws either way; the status strip only once a session arrived.
  const refused = `document.body.innerText.includes('already used or has expired')`;
  await waitFor('a session', `!!document.querySelector('.status-strip') || ${refused}`);
  if (await evaluate(refused))
    throw new Error('the link was refused: it is single-use and lasts 10 minutes');
  await shot('1-signed-in.png');

  await evaluate(`document.querySelector('textarea.composer-input').focus()`);
  await cdp('Input.insertText', { text: prompt });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });

  // Under REIKA_AUTO_APPROVE=off the tool call opens an approval; under bypass it never does.
  const approval = `!!document.querySelector('section.dialog[aria-label="Approval needed"]')`;
  const done = `document.body.innerText.includes('DRIVE_OK')`;
  await waitFor('an approval or the reply', `${approval} || ${done}`);
  if (await evaluate(approval)) {
    await shot('2-approval.png');
    await evaluate(`document.querySelector('.dialog-actions button').click()`);
  }
  await waitFor('the final reply', done);
  await sleep(300);
  await shot('3-reply-desktop.png');

  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(300);
  const overflow = await evaluate('document.documentElement.scrollWidth > window.innerWidth');
  if (overflow) console.log('WARN horizontal scroll at 390px');
  await shot('4-reply-phone.png');
  console.log('DRIVE_OK');
} catch (err) {
  failed = true;
  console.error(String(err?.message ?? err));
} finally {
  ws?.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
