// A model reads its own earlier `content` as its own voice, and a carried continuation tail (#284)
// puts reika's marker there: `[reika: N chars of your earlier reasoning trimmed …]`. A verbose model
// then opens a LATER reply the same way — observed on mimo-v2.6-pro (#745): a reply with its own
// tool call opening with `[reika: 26476 chars …]` (the harness had written 26465) and an invented
// `[tool result omitted: repeated from earlier]`, a stub reika never emits. Both rendered as the
// answer. So the match is on the shape, not on reika's exact strings: the copy is never exact.
//
// Head only, line by line: that is where the tail template puts the marker, and further down the
// same text is just as likely the model quoting reika's markers on purpose (a review of this code).
// Display/transcript only, like the reasoning fold — the Message the loop keeps and sends back is
// untouched.
const HARNESS_ECHO_LINE =
  /^\s*(?:\[reika:[^\]\n]*\]|\(reika:[^)\n]*\)|\[tool (?:result|output)[^\]\n]*\])\s*$/;

export function stripHarnessEcho(content: string): string {
  let rest = content;
  for (;;) {
    const lead = rest.match(/^\s*/)![0].length;
    const nl = rest.indexOf('\n', lead);
    const line = nl < 0 ? rest : rest.slice(0, nl);
    if (!line.trim() || !HARNESS_ECHO_LINE.test(line)) break;
    rest = nl < 0 ? '' : rest.slice(nl + 1);
  }
  return rest === content ? content : rest.trimStart();
}
