import { describe, expect, it } from 'vitest';
import { messagesToChatParams } from './toolcall.js';
import type { NativeImage } from '../agent/attachments.js';
import type { Message } from '../types.js';

// Native vision (VisionRoute 'native'): the image reaches the model as an OpenAI multimodal part
// on the ONE user message the user pasted it into, and nowhere else. The message itself stays text
// in history — this test is about the outgoing copy, which is the only place a non-string content
// field is ever allowed to exist.

const image = (marker: string, mime = 'image/png'): NativeImage => ({
  marker,
  mime,
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
});

// The user turn as the paste path builds it: the extracted block (here, the native note) followed
// by the user's own words, with the marker still in them.
const withImage = (marker: string, text = 'compare this with the log'): Message[] => [
  {
    role: 'user',
    content: `<image id="1" source="clipboard">\n${NOTE}\n</image>\n\n${text} ${marker}`,
  },
];

const NOTE = '(not transcribed — you were shown this image directly, once.)';

// `Message` is a union, so a fixture's user turn needs narrowing before its `content` can be read.
const userText = (history: Message[]): string => {
  const m = history[0];
  if (m.role !== 'user') throw new Error('fixture must open with a user turn');
  return m.content;
};

type UserParam = { role: 'user'; content: string | Array<Record<string, unknown>> };

const users = (params: unknown[]): UserParam[] =>
  params.filter((p): p is UserParam => (p as { role?: string }).role === 'user');

const asParts = (param: UserParam): Array<Record<string, unknown>> => {
  if (typeof param.content === 'string') throw new Error('content stayed a string');
  return param.content;
};

describe('messagesToChatParams — native images', () => {
  it('leaves the request byte-identical when nothing was pasted', () => {
    const plain = users(messagesToChatParams('sys', withImage('[Image 1]')));
    expect(typeof plain[0].content).toBe('string');
  });

  // The whole point of the route: the same history, serialized the same way, everywhere else in
  // the pipeline. Aging, compaction, spill and transcripts only ever see this string.
  it('keeps an unmatched marker as plain text rather than sending bytes anyway', () => {
    const params = users(
      messagesToChatParams('sys', withImage('[Image 1]'), {
        nativeImages: [image('[Image 2]')],
      }),
    );
    expect(typeof params[0].content).toBe('string');
  });

  it('folds the image into the message whose text carries its marker, text first', () => {
    const original = userText(withImage('[Image 1]'));
    const params = users(
      messagesToChatParams('sys', withImage('[Image 1]'), {
        nativeImages: [image('[Image 1]')],
      }),
    );
    const parts = asParts(params[0]);
    expect(parts[0]).toEqual({ type: 'text', text: original });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`,
      },
    });
    expect(parts).toHaveLength(2);
  });

  it('carries the sniffed mime, not a hardcoded png', () => {
    const params = users(
      messagesToChatParams('sys', withImage('[Image 1]'), {
        nativeImages: [image('[Image 1]', 'image/jpeg')],
      }),
    );
    expect(asParts(params[0])[1]).toEqual({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`,
      },
    });
  });

  it('stacks several images on the one message, in order', () => {
    const history: Message[] = [{ role: 'user', content: `${NOTE} [Image 1] and [Image 2]` }];
    const params = users(
      messagesToChatParams('sys', history, {
        nativeImages: [image('[Image 1]'), image('[Image 2]', 'image/jpeg')],
      }),
    );
    const parts = asParts(params[0]);
    expect(parts).toHaveLength(3);
    expect(String((parts[1].image_url as { url: string }).url)).toContain('image/png');
    expect(String((parts[2].image_url as { url: string }).url)).toContain('image/jpeg');
  });

  it('attaches to the last user message, never an earlier turn', () => {
    const history: Message[] = [
      { role: 'user', content: `earlier [Image 1]` },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: `now [Image 1]` },
    ];
    const params = users(
      messagesToChatParams('sys', history, { nativeImages: [image('[Image 1]')] }),
    );
    expect(typeof params[0].content).toBe('string');
    expect(asParts(params[1])[0]).toEqual({ type: 'text', text: 'now [Image 1]' });
  });

  // The trailing note is appended as a final user message every round; the images belong to the
  // turn's real message, and the note must stay a plain string behind them.
  it('does not attach to the trailing harness note', () => {
    const original = userText(withImage('[Image 1]'));
    const params = users(
      messagesToChatParams('sys', withImage('[Image 1]'), {
        nativeImages: [image('[Image 1]')],
        trailingNote: 'LEDGER',
      }),
    );
    expect(asParts(params[0])[0]).toEqual({ type: 'text', text: original });
    expect(params[1].content).toBe('LEDGER');
  });
});
