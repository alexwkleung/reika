import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OutputLines } from './OutputLines.js';

const lines = (html: string) =>
  [...html.matchAll(/<span class="output-line">([^<]*)<\/span>/g)].map(m => m[1]);

describe('OutputLines', () => {
  it('draws one block per line and keeps each newline, so a copy is the output byte for byte', () => {
    const html = renderToStaticMarkup(<OutputLines className="command-tail" text={'a\n\nb'} />);
    expect(lines(html)).toEqual(['a\n', '\n', 'b']);
    expect(lines(html).join('')).toBe('a\n\nb');
  });
});
