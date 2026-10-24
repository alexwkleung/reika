import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Config } from '../types.js';
import { callModel } from './client.js';

// A degrade latch drops a field after the server rejects it, so the stripped retry must be the
// SECOND request the server sees (#804). The transport used to retry a 400 as a network error,
// and the server got the rejected request three times first. Against a real socket, since the
// client tests mock the transport and cannot see its retries.

const config = (baseURL: string): Config => ({
  baseURL,
  apiKey: '',
  model: 'test',
  models: ['test'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'bypass',
  subagentMaxTurns: 5,
  profiles: {},
  minGenTokens: 1024,
  reasoningRounds: 1,
  maxSearchesPerTurn: 0,
  maxFetchesPerTurn: 0,
  bashTimeoutMs: 5000,
  bashIdleMs: 5000,
  pasteFetch: 'off',
  skillAuto: 'off',
  anon: false,
  sandbox: false,
});

describe('degrade retry over the real transport (#804)', () => {
  it('sends the rejected request once, then the stripped one', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        if ('chat_template_kwargs' in body) {
          res.writeHead(400).end('unknown field chat_template_kwargs');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const r = await callModel({
        system: 'sys',
        history: [],
        tools: [],
        config: config(`http://127.0.0.1:${port}/v1`),
      });
      expect(r.content).toBe('ok');
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty('chat_template_kwargs');
      expect(bodies[1]).not.toHaveProperty('chat_template_kwargs');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
