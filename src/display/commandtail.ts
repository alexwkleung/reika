// The end of a command's output the chip shows: the last OUTPUT_TAIL_LINES lines of at most
// OUTPUT_TAIL_BYTES. One rule for the committed chip (tools/bash.ts) and the page's live block
// (#1014), so a running command and its result draw the same rows and the commit does not move
// them. Imports nothing: the browser page bundles it.

export const OUTPUT_TAIL_BYTES = 2 * 1024;
export const OUTPUT_TAIL_LINES = 10;

// `omittedEarlier`: the caller already dropped output before `retained`, which the text alone
// cannot show — a full window looks like a run of exactly that size.
export function commandTail(
  retained: string,
  omittedEarlier = false,
): { outputTail: string; outputTruncated: boolean } {
  // Blank edges are dropped: nearly every command ends in a newline (vitest and `git log` in two),
  // and each drew as an empty row stacked on the next block's own margin, while also taking one of
  // the ten line slots from real output.
  const trimmed = retained.replace(/\s+$/, '');
  if (!trimmed) return { outputTail: '', outputTruncated: false };
  const byteTail =
    trimmed.length > OUTPUT_TAIL_BYTES
      ? trimmed.slice(trimmed.length - OUTPUT_TAIL_BYTES)
      : trimmed;
  const lines = byteTail.split('\n');
  const lineTail = lines.slice(-OUTPUT_TAIL_LINES);
  const outputTruncated =
    omittedEarlier || trimmed.length > byteTail.length || lines.length > OUTPUT_TAIL_LINES;
  const outputTail = lineTail.join('\n').replace(/^(?:[ \t\r]*\n)+/, '');
  return { outputTail, outputTruncated };
}
