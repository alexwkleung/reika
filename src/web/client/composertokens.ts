// The runs of the input box's text drawn as bubbles behind it (Composer's backdrop): a slash
// command at the start of the line, and the markers that stand in for a large paste or an image.
// Shape only, nothing else: the page has no command list, so a lowercase `/name` that opens the
// line and is followed by a space or the end is one (`/Users/…` and `/tmp/x` are not). A wrong
// bubble costs a tint, nothing more.

export type Segment = { text: string; token?: 'command' | 'marker' };

const COMMAND = /^\/[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)?(?=\s|$)/;
const MARKER = /\[Pasted text #\d+ \+[^\]\n]+\]|\[Image \d+\]/g;

export function composerTokens(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  const command = COMMAND.exec(text);
  if (command) {
    out.push({ text: command[0], token: 'command' });
    at = command[0].length;
  }
  MARKER.lastIndex = at;
  for (let m = MARKER.exec(text); m; m = MARKER.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], token: 'marker' });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
