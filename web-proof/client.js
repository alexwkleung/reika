// Throwaway proof client for #584 on the `web` branch: proves the protocol end to end and is
// replaced by a designed UI. Never merged to main. Text goes through textContent only, since
// everything the server sends may carry model output.
'use strict';

const PROTOCOL_VERSION = 1;
const $ = id => document.getElementById(id);

// A link carries a single-use code in its fragment. It is traded for the token once, taken off the
// address bar, and the token is kept for this tab.
const NEW_LINK_HINT = 'Press Enter in the terminal running `reika web` for a new link.';
let token = sessionStorage.getItem('reika-token');

async function tradeLinkCode() {
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  if (!code) return;
  history.replaceState(null, '', location.pathname);
  try {
    const res = await fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      if (!token) banner('This link was already used or has expired. ' + NEW_LINK_HINT);
      return;
    }
    token = (await res.json()).token;
    sessionStorage.setItem('reika-token', token);
  } catch (e) {
    banner(String(e));
  }
}

let lastSeq = null;
let streamAbort = null;
let state = null;
let live = null;
const dialogs = new Map();

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function banner(text) {
  const b = $('banner');
  b.hidden = !text;
  b.textContent = text || '';
}

function compact(value) {
  return JSON.stringify(value);
}

// ---- committed rows -------------------------------------------------------------------------

function renderMessage(m) {
  const row = el('div', 'row ' + (m.nested ? 'nested ' : ''));
  switch (m.role) {
    case 'user':
      row.classList.add('user');
      row.textContent = (m.meta ? '' : '▎ ') + (m.display ?? m.content);
      break;
    case 'assistant': {
      if (m.compactionNote) row.appendChild(el('div', 'info', '── compaction note'));
      if (m.reasoning) {
        const d = el('details');
        d.appendChild(el('summary', null, 'Thinking'));
        d.appendChild(el('pre', null, m.reasoning));
        row.appendChild(d);
      }
      if (m.content) row.appendChild(el('div', m.discarded ? 'muted' : null, m.content));
      for (const call of m.toolCalls ?? []) {
        row.appendChild(el('div', 'call', '· ' + call.name + '(' + compact(call.args) + ')'));
      }
      if (m.harnessStop)
        row.appendChild(el('div', 'warn', '(stopped by reika: ' + m.harnessStop + ')'));
      if (m.sources?.length)
        row.appendChild(el('div', 'muted', 'sources: ' + m.sources.join(', ')));
      break;
    }
    case 'tool':
      row.classList.add('tool');
      row.appendChild(
        el(
          'div',
          null,
          '↳ ' +
            m.summary +
            (m.durationMs >= 5000 ? ' · ' + Math.round(m.durationMs / 1000) + 's' : ''),
        ),
      );
      if (m.command) {
        row.appendChild(el('pre', 'shell', '$ ' + m.command.text));
        if (m.command.outputTail) {
          row.appendChild(
            el(
              'pre',
              null,
              (m.command.outputTruncated ? '…(earlier output omitted)\n' : '') +
                m.command.outputTail,
            ),
          );
        }
      }
      if (m.diff)
        row.appendChild(
          el(
            'pre',
            null,
            m.diff.path + ' +' + m.diff.added + ' -' + m.diff.removed + '\n' + m.diff.text,
          ),
        );
      for (const f of m.changes?.files ?? []) row.appendChild(el('pre', 'dump', compact(f)));
      break;
    case 'system':
      row.classList.add(m.tone === 'warn' ? 'warn' : m.tone === 'info' ? 'info' : 'muted');
      row.textContent = '❯ ' + m.content;
      break;
    case 'error':
      row.classList.add('error');
      row.textContent = '✗ ' + m.content;
      break;
    case 'shell':
      row.classList.add('shell');
      row.appendChild(el('div', null, '$ ' + m.command));
      row.appendChild(el('pre', null, m.output));
      break;
    default:
      row.classList.add('dump');
      row.textContent = '[' + m.role + '] ' + compact(m);
  }
  return row;
}

function appendRow(m) {
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  $('rows').appendChild(renderMessage(m));
  if (atBottom) window.scrollTo(0, document.body.scrollHeight);
}

// ---- live turn ------------------------------------------------------------------------------

let liveQueued = false;
function renderLiveSoon() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => {
    liveQueued = false;
    renderLive();
  });
}

function renderLive() {
  const box = $('live');
  box.replaceChildren();
  if (!live) return;
  const flags = ['typechecking', 'recovering', 'looping', 'subagent', 'note'].filter(k => live[k]);
  if (live.phase || flags.length)
    box.appendChild(
      el(
        'div',
        'muted',
        'phase: ' + (live.phase ?? '-') + (flags.length ? ' [' + flags.join(', ') + ']' : ''),
      ),
    );
  if (live.promptProgress) {
    const p = live.promptProgress;
    const work = Math.max(1, p.total - p.cached);
    box.appendChild(
      el('div', 'muted', 'prefill ' + Math.round(((p.processed - p.cached) / work) * 100) + '%'),
    );
  }
  if (live.reasoning) {
    const d = el('details');
    d.open = true;
    d.appendChild(el('summary', null, 'Thinking'));
    d.appendChild(el('pre', null, live.reasoning));
    box.appendChild(d);
  }
  if (live.content) box.appendChild(el('div', 'row', live.content));
  if (live.tool)
    box.appendChild(
      el('pre', 'tool', (live.tool.name ? live.tool.name + ':\n' : '') + live.tool.output),
    );
  if (live.pending) box.appendChild(el('div', 'tool', '↳ ' + live.pending.name + '…'));
  if (live.plan?.length) {
    for (const s of live.plan)
      box.appendChild(
        el(
          'div',
          s.done ? 'shell' : 'muted',
          (s.done ? '[x] ' : s.waived ? '[~] ' : '[ ] ') + s.n + '. ' + s.text,
        ),
      );
  }
  if (live.usage) box.appendChild(el('div', 'muted', 'live usage: ' + compact(live.usage)));
}

// ---- status ---------------------------------------------------------------------------------

const SHOWN = [
  'mode',
  'status',
  'error',
  'model',
  'profile',
  'cwd',
  'autoApprove',
  'unattended',
  'usage',
  'estimatedContext',
  'contextWindow',
  'decodeRate',
  'queue',
];
function renderStatus() {
  if (!state) return;
  const s = state;
  const parts = [
    s.mode,
    s.status,
    s.model + (s.profile && s.profile !== 'default' ? ' (' + s.profile + ')' : ''),
    s.cwd,
  ];
  parts.push('approve=' + s.autoApprove + (s.unattended ? ' unattended' : ''));
  parts.push('tokens ' + s.usage.promptTokens + '/' + s.usage.completionTokens);
  if (s.estimatedContext !== null)
    parts.push('ctx ' + s.estimatedContext + (s.contextWindow ? '/' + s.contextWindow : ''));
  if (s.decodeRate !== null) parts.push(s.decodeRate.toFixed(1) + ' tok/s');
  if (s.queue.length) parts.push('queued: ' + s.queue.map(q => q.content).join(' | '));
  if (s.error) parts.push('error: ' + s.error);
  const rest = {};
  for (const k of Object.keys(s)) if (!SHOWN.includes(k)) rest[k] = s[k];
  $('status').textContent = parts.join(' · ') + '  ' + compact(rest);
  $('stop').hidden = s.status !== 'busy';
}

// ---- dialogs --------------------------------------------------------------------------------

function button(label, onClick) {
  const b = el('button', null, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderDialog(id, d) {
  const box = el('div', 'dialog');
  const err = el('div', 'error');
  const answer = body =>
    send({ type: 'answer', id, kind: d.kind, ...body }).then(e => (err.textContent = e || ''));
  box.appendChild(el('div', 'warn', d.kind + ' ' + id));
  if (d.kind === 'approval') {
    box.appendChild(el('div', null, d.tool + ': ' + d.subject));
    for (const w of d.warnings ?? []) box.appendChild(el('div', 'warn', '⚠ ' + w));
    box.appendChild(el('pre', null, d.preview));
    const reason = el('input');
    reason.placeholder = 'reason (optional, sent with No)';
    box.appendChild(button('Yes', () => answer({ answer: true })));
    box.appendChild(button('Always (this session)', () => answer({ answer: true, always: true })));
    box.appendChild(
      button('No', () => answer({ answer: reason.value ? { feedback: reason.value } : false })),
    );
    box.appendChild(reason);
  } else if (d.kind === 'question') {
    box.appendChild(el('div', null, d.question));
    d.options.forEach((o, index) => {
      box.appendChild(
        button((o.recommended ? '★ ' : '') + o.label, () =>
          answer({ answer: { text: o.label, index } }),
        ),
      );
      if (o.description) box.appendChild(el('div', 'muted', '  ' + o.description));
    });
    const free = el('input');
    free.placeholder = 'or type an answer';
    box.appendChild(free);
    box.appendChild(button('Send', () => answer({ answer: { text: free.value } })));
    box.appendChild(button('Cancel', () => answer({ answer: null })));
  } else if (d.kind === 'confirm') {
    box.appendChild(el('div', null, d.title));
    if (d.subtitle) box.appendChild(el('div', 'muted', d.subtitle));
    for (const line of d.details) box.appendChild(el('div', 'muted', line));
    d.options.forEach((label, choice) =>
      box.appendChild(
        button((choice === d.initial ? '› ' : '') + (choice + 1) + '. ' + label, () =>
          answer({ choice }),
        ),
      ),
    );
    box.appendChild(button('Cancel', () => answer({ choice: 'abort' })));
  } else if (d.kind === 'model') {
    for (const t of d.targets)
      box.appendChild(
        button((t.active ? '› ' : '') + t.name + ' (' + t.model + ', ' + t.kind + ')', () =>
          answer({ name: t.name }),
        ),
      );
    box.appendChild(button('Cancel', () => answer({ name: null })));
  } else if (d.kind === 'session') {
    box.appendChild(el('div', null, d.heading));
    for (const e of d.entries)
      box.appendChild(
        button((e.title ?? 'untitled') + ' · ' + e.savedAt + ' · ' + e.messageCount + ' msgs', () =>
          answer({ path: e.path }),
        ),
      );
    box.appendChild(button('Cancel', () => answer({ path: null })));
  } else {
    box.appendChild(el('pre', 'dump', compact(d)));
  }
  box.appendChild(err);
  return box;
}

function openDialog(id, d) {
  dialogs.get(id)?.remove();
  const node = renderDialog(id, d);
  dialogs.set(id, node);
  $('dialogs').appendChild(node);
}

function clearDialogs() {
  for (const node of dialogs.values()) node.remove();
  dialogs.clear();
}

// ---- events ---------------------------------------------------------------------------------

function onEvent(ev) {
  if ('seq' in ev) lastSeq = ev.seq;
  switch (ev.type) {
    case 'hello':
      // A hello opens a snapshot, which lists every dialog still open.
      clearDialogs();
      banner(
        ev.version === PROTOCOL_VERSION
          ? ''
          : 'protocol version ' + ev.version + ', this page speaks ' + PROTOCOL_VERSION,
      );
      break;
    case 'reset':
      $('rows').replaceChildren();
      for (const m of ev.messages) appendRow(m);
      break;
    case 'message':
      appendRow(ev.message);
      break;
    case 'state':
      state = ev.state;
      renderStatus();
      break;
    case 'dialog':
      openDialog(ev.id, ev.dialog);
      break;
    case 'resolved':
      dialogs.get(ev.id)?.remove();
      dialogs.delete(ev.id);
      break;
    case 'live':
      live = ev.live;
      renderLiveSoon();
      break;
    case 'delta':
      if (!live) break;
      if (ev.channel === 'tool') {
        if (live.tool) live.tool.output += ev.text;
      } else {
        live[ev.channel] += ev.text;
      }
      renderLiveSoon();
      break;
    default:
      appendRow({ role: 'event', ...ev });
  }
}

// Read with fetch, not EventSource, so the token goes in a header and never in a URL. A dropped
// stream is reopened from the last seq seen.
async function openStream() {
  if (!token) {
    if ($('banner').hidden) banner('Not signed in. ' + NEW_LINK_HINT);
    $('status').textContent = 'not connected';
    return;
  }
  streamAbort = new AbortController();
  const headers = { Authorization: 'Bearer ' + token };
  if (lastSeq !== null) headers['Last-Event-ID'] = String(lastSeq);
  let res;
  try {
    res = await fetch('/events', { headers, signal: streamAbort.signal });
  } catch {
    banner('Cannot reach the server. Retrying in 3s…');
    setTimeout(openStream, 3000);
    return;
  }
  if (res.status === 401) {
    sessionStorage.removeItem('reika-token');
    token = null;
    banner('The server no longer accepts this tab (it was restarted). ' + NEW_LINK_HINT);
    $('status').textContent = 'not connected';
    return;
  }
  if (!res.ok) {
    banner('Stream refused (' + res.status + '). Retrying in 3s…');
    setTimeout(openStream, 3000);
    return;
  }
  banner('');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (data) onEvent(JSON.parse(data));
      }
    }
  } catch {
    // Falls through to the reconnect below.
  }
  banner('Stream dropped; reconnecting…');
  setTimeout(openStream, 1000);
}

// Resolves to an error string, or '' on success.
async function send(message) {
  try {
    const res = await fetch('/message', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (res.ok) return '';
    return res.status + ': ' + (await res.text());
  } catch (e) {
    return String(e);
  }
}

// ---- input ----------------------------------------------------------------------------------

const text = $('text');
async function submit() {
  const value = text.value;
  if (!value.trim()) return;
  text.value = '';
  const err = await send({ type: 'submit', text: value });
  if (err) {
    text.value = value;
    banner(err);
  }
}
text.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
});
$('input').addEventListener('submit', e => {
  e.preventDefault();
  void submit();
});
$('stop').addEventListener('click', async () => banner(await send({ type: 'abort' })));

function refuseImages(e, items) {
  if (![...(items ?? [])].some(i => i.type.startsWith('image/'))) return;
  e.preventDefault();
  banner('Images are not supported in the web UI yet (#979).');
}
text.addEventListener('paste', e => refuseImages(e, e.clipboardData?.items));
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  refuseImages(e, e.dataTransfer?.items);
});

void tradeLinkCode().then(openStream);
