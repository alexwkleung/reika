import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Harness-cost regression bench: a scripted model behind a real HTTP endpoint, so a session runs
// reika's real loop, tools and serialization, and every request body is captured as sent. The model
// never reacts to what it is shown, so this measures what the harness costs — request size and how
// much of each request an engine's prefix cache could reuse — never how well a model does.

export type ScriptedCall = { name: string; args: Record<string, unknown> };
export type ScriptedReply = { content?: string; reasoning?: string; toolCalls?: ScriptedCall[] };

type ChatMessage = { role: string; [key: string]: unknown };
export type ChatBody = {
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens?: number;
};

export type MockModel = {
  baseURL: string;
  requests: ChatBody[];
  close(): Promise<void>;
};

// A dense tokenizer reports more tokens than char/4, which is the case calibration exists for — so
// the mock reports chars/3, deterministic, and the bench exercises the calibrated path.
const MOCK_CHARS_PER_TOKEN = 3;

export async function startMockModel(reply: (body: ChatBody) => ScriptedReply): Promise<MockModel> {
  const requests: ChatBody[] = [];
  let callSeq = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as ChatBody;
      requests.push(body);
      const out = reply(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (chunk: unknown): void => void res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (out.reasoning) send({ choices: [{ delta: { reasoning_content: out.reasoning } }] });
      if (out.content) send({ choices: [{ delta: { content: out.content } }] });
      (out.toolCalls ?? []).forEach((call, index) =>
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_${++callSeq}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  },
                ],
              },
            },
          ],
        }),
      );
      const promptTokens = Math.ceil(raw.length / MOCK_CHARS_PER_TOKEN);
      send({
        choices: [{ delta: {}, finish_reason: out.toolCalls?.length ? 'tool_calls' : 'stop' }],
      });
      send({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 50 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

// How a request relates to the one before it, as an engine's prefix cache sees it. The tool list
// renders into the system turn in common chat templates (#426), so it is segment 0 and a change
// there invalidates everything.
export type Divergence =
  | 'first'
  | 'append-only'
  | 'tail-rewrite'
  | 'tools-changed'
  | 'system-changed'
  | 'mid-history';

export type RequestRow = {
  index: number;
  // A report round (compaction note, subagent report) forbids calls through tool_choice.
  kind: 'round' | 'report';
  messages: number;
  chars: number;
  divergence: Divergence;
  firstChanged: number;
  // Chars from the first changed segment on: what a prefix cache would have to reprocess.
  reprocessChars: number;
};

function segmentsOf(body: ChatBody, normalize: (s: string) => string): string[] {
  return [
    normalize(JSON.stringify(body.tools ?? [])),
    ...body.messages.map(m => normalize(JSON.stringify(m))),
  ];
}

function classify(prev: string[], cur: string[], firstChanged: number): Divergence {
  if (firstChanged >= prev.length) return 'append-only';
  if (firstChanged === 0) return 'tools-changed';
  if (firstChanged === 1) return 'system-changed';
  // Only the previous request's last message differs: the transient trailing note's own slot,
  // displaced by the round's append — cheap, and expected every round under prefix-stable.
  if (firstChanged === prev.length - 1) return 'tail-rewrite';
  return 'mid-history';
}

export function measureRequests(
  requests: ChatBody[],
  normalize: (s: string) => string = s => s,
): RequestRow[] {
  let prev: string[] | undefined;
  return requests.map((body, index) => {
    const cur = segmentsOf(body, normalize);
    const chars = cur.reduce((n, s) => n + s.length, 0);
    let firstChanged = 0;
    if (prev)
      while (
        firstChanged < Math.min(prev.length, cur.length) &&
        prev[firstChanged] === cur[firstChanged]
      )
        firstChanged++;
    const divergence = prev ? classify(prev, cur, firstChanged) : 'first';
    const reprocessChars = cur.slice(firstChanged).reduce((n, s) => n + s.length, 0);
    prev = cur;
    return {
      index,
      kind: body.tool_choice === 'none' ? 'report' : 'round',
      messages: body.messages.length,
      chars,
      divergence,
      firstChanged,
      reprocessChars,
    };
  });
}

export function formatBenchTable(
  rows: RequestRow[],
  shrink: { sheds: number; folds: number },
): string {
  const lines = rows.map(r =>
    [
      String(r.index).padStart(3),
      r.kind.padEnd(6),
      `msgs=${String(r.messages).padStart(3)}`,
      `chars=${String(r.chars).padStart(6)}`,
      `reprocess=${String(r.reprocessChars).padStart(6)}`,
      `${r.divergence}${r.divergence === 'mid-history' ? `@${r.firstChanged}` : ''}`,
    ].join('  '),
  );
  const sent = rows.reduce((n, r) => n + r.chars, 0);
  const reprocessed = rows.reduce((n, r) => n + r.reprocessChars, 0);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.divergence, (counts.get(r.divergence) ?? 0) + 1);
  const byClass = [...counts].map(([k, v]) => `${k}=${v}`).join(' ');
  lines.push(
    '',
    `requests=${rows.length} sent=${sent} reprocessed=${reprocessed}`,
    `sheds=${shrink.sheds} folds=${shrink.folds}`,
    byClass,
  );
  return lines.join('\n') + '\n';
}
