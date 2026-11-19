// An OpenAI-compatible SSE mock for driving reika end to end. Usage:
//   node mock-server.mjs <port> <request-log.jsonl>
// One bash tool call, then a final reply naming DRIVE_OK. Dispatches on the request body, never a
// counter: REIKA_WARM's probe and the client's own retries would shift a counter.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [port = '8799', log = 'mock-requests.jsonl'] = process.argv.slice(2);

const chunk = (res, body) => res.write(`data: ${JSON.stringify(body)}\n\n`);
const frame = (delta, finish = null) => ({
  id: 'mock',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'test', object: 'model' }] }));
    return;
  }
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const messages = body.messages ?? [];
    const warm = (body.max_tokens ?? 999) <= 4;
    const kind = warm ? 'warm' : messages.some(m => m.role === 'tool') ? 'final' : 'toolcall';
    const last = messages.at(-1);
    appendFileSync(
      log,
      JSON.stringify({
        kind,
        max_tokens: body.max_tokens,
        roles: messages.map(m => m.role),
        last: String(last?.content ?? '').slice(0, 120),
      }) + '\n',
    );
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // A delay, so the busy state and an abort are observable.
    setTimeout(() => {
      if (kind === 'warm') {
        chunk(res, frame({}, 'stop'));
      } else if (kind === 'toolcall') {
        chunk(res, frame({ role: 'assistant', content: 'Running a command.' }));
        chunk(
          res,
          frame({
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ command: 'echo hello-from-tool' }),
                },
              },
            ],
          }),
        );
        chunk(res, frame({}, 'tool_calls'));
      } else {
        chunk(
          res,
          frame({ role: 'assistant', content: 'The command printed hello-from-tool. DRIVE_OK' }),
        );
        chunk(res, frame({}, 'stop'));
      }
      chunk(res, {
        id: 'mock',
        object: 'chat.completion.chunk',
        choices: [],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      });
      res.end('data: [DONE]\n\n');
    }, 400);
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`mock on ${port}`));
