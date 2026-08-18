// How wide a block actually is, in columns.
//
// Ink lays a <Static> row out at its INTRINSIC width, not the terminal's: a Box in row direction
// hands each child the width it asks for and lets the row overflow. A column of <Text> wraps
// (the child inherits the parent's width), which is why most of the scrollback behaves — but a
// label-and-value row (`cwd:  <path>`, the header line) does not, and a long value runs off the
// edge for the TERMINAL to wrap, mid-token, with no hanging indent. Giving the row an explicit
// width is what puts the wrap back under Ink's control.
//
// `indent` is any margin the block sits behind (the diff view's marginLeft, a nested subagent
// block), which the block's own layout has to pay for out of the same columns.
export function contentWidth(indent = 0): number {
  // The App renders everything inside paddingX={1}, so two columns are gone before any block
  // starts. The floor keeps a pathologically narrow terminal from producing a zero-width layout.
  return Math.max(20, (process.stdout.columns || 80) - 2 - indent);
}
