import { describe, expect, it } from 'vitest';
import { createSSEDecoder } from './transport.js';
import type { ChatCompletionChunk, SSEEvent } from './transport.js';

const enc = new TextEncoder();

// Feed a string to the decoder, optionally splitting it into byte fragments at the given
// boundaries, to simulate arbitrary network read boundaries.
function decodeAll(text: string, splitAt: number[] = []): SSEEvent[] {
  const bytes = enc.encode(text);
  const cuts = [0, ...splitAt, bytes.length];
  const decoder = createSSEDecoder();
  const events: SSEEvent[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    events.push(...decoder.push(bytes.slice(cuts[i], cuts[i + 1])));
  }
  events.push(...decoder.flush());
  return events;
}

function chunks(events: SSEEvent[]): ChatCompletionChunk[] {
  return events
    .filter(e => e.kind === 'chunk')
    .map(e => (e as { chunk: ChatCompletionChunk }).chunk);
}

describe('createSSEDecoder', () => {
  it('decodes a simple data frame', () => {
    const events = decodeAll('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    expect(chunks(events)).toHaveLength(1);
    expect(chunks(events)[0].choices?.[0]?.delta?.content).toBe('hi');
  });

  it('emits a done event for [DONE]', () => {
    const events = decodeAll('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    expect(events.map(e => e.kind)).toEqual(['chunk', 'done']);
  });

  it('reassembles a frame split across reads at an arbitrary byte boundary', () => {
    const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
    // Split mid-JSON — the decoder must buffer until the newline arrives.
    for (const cut of [5, 20, frame.length - 3]) {
      const out = chunks(decodeAll(frame, [cut]));
      expect(out).toHaveLength(1);
      expect(out[0].choices?.[0]?.delta?.content).toBe('hello');
    }
  });

  it('reassembles a multi-byte UTF-8 char split across two reads', () => {
    // "café" — the é is two bytes; cut between them so a naive per-chunk decode would corrupt it.
    const frame = 'data: {"choices":[{"delta":{"content":"café"}}]}\n\n';
    const bytes = enc.encode(frame);
    const eIdx = frame.indexOf('é');
    // Byte offset of the first byte of é (ASCII prefix means char index == byte index here).
    const out = chunks(decodeAll(frame, [eIdx + 1]));
    expect(out[0].choices?.[0]?.delta?.content).toBe('café');
    expect(bytes.length).toBeGreaterThan(frame.length); // sanity: é really is multi-byte
  });

  it('skips keep-alive comment lines and non-data fields', () => {
    const text = ': keep-alive\nevent: message\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    const out = chunks(decodeAll(text));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('x');
  });

  it('tolerates CRLF line endings', () => {
    const out = chunks(decodeAll('data: {"choices":[{"delta":{"content":"y"}}]}\r\n\r\n'));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('y');
  });

  it('parses a trailing frame with no terminating newline on flush', () => {
    const out = chunks(decodeAll('data: {"choices":[{"delta":{"content":"tail"}}]}'));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('tail');
  });

  it('drops an unparseable frame without crashing the stream', () => {
    const text = 'data: {bad json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
    const out = chunks(decodeAll(text));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('ok');
  });

  it('decodes a usage-only final frame (cache + tokens)', () => {
    const text =
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,' +
      '"prompt_tokens_details":{"cached_tokens":4}}}\n\n';
    const u = chunks(decodeAll(text))[0].usage;
    expect(u?.prompt_tokens).toBe(10);
    expect(u?.prompt_tokens_details?.cached_tokens).toBe(4);
  });

  it('handles multiple frames delivered in one read', () => {
    const text =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n';
    const out = chunks(decodeAll(text));
    expect(out.map(c => c.choices?.[0]?.delta?.content)).toEqual(['a', 'b']);
  });
});
