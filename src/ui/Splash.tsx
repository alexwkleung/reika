import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { displayCwd } from './scrub.js';
import { contentWidth } from './layout.js';

// Header (#132): a thin vertical bar in the orchid ramp beside the name, model and cwd — the
// height of the other agent harnesses' headers. The bar is the brand mark: a single glyph can't
// be made larger in a terminal, and a flower drawn in block cells is a 12-pixel approximation
// of a curve, so the gradient carries the identity rather than a shape. `▐` is a half-cell with
// one colour per row: three stops for the three rows, re-interpolated when a subagent adds a
// fourth. The ramp is the retired block-letter wordmark's, single-hue, pale bloom to deep plum —
// monochrome on purpose, off the blue→magenta "AI CLI" palette.
const BAR = '▐';
// The filled florette (✿, U+273F) leads the name — reika (レイカ) means "beautiful flower".
const MARK = '✿';
const RAMP_START = [0xed, 0xc4, 0xe8];
const RAMP_END = [0xa1, 0x3d, 0x93];
const NAME = 'Reika';

/** `n` evenly spaced stops along the ramp, start and end inclusive. */
function ramp(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    const hex = RAMP_START.map((c, k) => Math.round(c + (RAMP_END[k] - c) * t))
      .map(c => c.toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  });
}

export function Splash({
  model,
  cwd,
  version,
  subagent,
}: {
  model: string;
  cwd: string;
  version: string;
  subagent?: string;
}) {
  const tag = `v${version}`;
  // Name · version, model (and subagent), cwd as bare values beside the bar — the bar and the
  // name are the labels. The column's width is bounded so a deep cwd wraps under Ink, indented
  // under the column, instead of spilling past the edge for the terminal to break mid-path
  // (these rows live in <Static>, where an unbounded row is laid out at intrinsic width). See
  // layout.ts. The bar is one cell per row, so it stays flush with however many rows there are.
  const rows = 3 + (subagent ? 1 : 0);
  const stops = ramp(rows);
  const gutter = 2;
  const columnWidth = Math.max(10, contentWidth() - BAR.length - gutter);
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Box flexDirection="column">
          {stops.map((color, i) => (
            <Text key={i} color={color}>
              {BAR}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginLeft={gutter} width={columnWidth}>
          <Box>
            <Text color={theme.accent} bold>
              {`${MARK} ${NAME}`}
            </Text>
            <Text color={theme.muted}>{` · ${tag}`}</Text>
          </Box>
          <Text>{model}</Text>
          {subagent ? <Text color={theme.secondary}>{subagent}</Text> : null}
          <Text color={theme.secondary}>{displayCwd(cwd)}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>/help for commands · @ to attach files</Text>
      </Box>
    </Box>
  );
}
