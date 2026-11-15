import type { ClientMessage, WireCompletion, WireSessionList } from '../protocol.js';

// POST /message. A 409 is its own result: the dialog was answered elsewhere or is gone, which a
// screen shows differently from a failure.

// `reply` is what a `complete` or a `sessions` asked for; absent for every other message.
export type SendResult =
  | { kind: 'ok'; reply?: WireCompletion | WireSessionList }
  | { kind: 'conflict'; error: string }
  | { kind: 'signed-out' }
  | { kind: 'failed'; status: number | null; error: string };

// The server answers JSON `{ error }` for what it parsed and plain text for what it refused first.
async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {}
  return text || `HTTP ${res.status}`;
}

export async function sendMessage(
  token: string,
  message: ClientMessage,
  fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn('/message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch (e) {
    return { kind: 'failed', status: null, error: (e as Error).message };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as {
      reply?: WireCompletion | WireSessionList;
    } | null;
    return body && 'reply' in body ? { kind: 'ok', reply: body.reply } : { kind: 'ok' };
  }
  if (res.status === 401) return { kind: 'signed-out' };
  const error = await errorText(res);
  if (res.status === 409) return { kind: 'conflict', error };
  return { kind: 'failed', status: res.status, error };
}
