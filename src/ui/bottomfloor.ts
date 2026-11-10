import type { DOMElement } from 'ink';

// Bottom floor (experimental, `REIKA_INPUT_FLOOR=0` is the baseline arm). Ink draws the live frame
// at the cursor, so the input sits wherever the rows printed so far end: it walks down the screen
// until the first screenful, and a frame that gets shorter leaves it short of the bottom until
// output pushes it back. The floor keeps the frame's last row on the terminal's: the frame is
// never shorter than the rows it still owes the screen, which start at `rows - 1` and are paid off
// by what commits above it. The slack is a flexGrow spacer above the input (App).

// Rows the frame must still cover after a layout that commits `committed` rows above it. One under
// the viewport at most: at `rows` Ink repaints with a scrollback clear.
export function owedRows(owed: number, committed: number, rows: number): number {
  return Math.max(0, Math.min(owed - committed, rows - 1));
}

export function inputFloorEnabled(
  stdout: { rows?: number; isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.REIKA_INPUT_FLOOR !== '0' && !!stdout.isTTY && !!stdout.rows;
}

type InkRoot = DOMElement & { staticNode?: DOMElement; onComputeLayout?: () => void };
type ResizableStdout = {
  rows?: number;
  prependListener: (event: 'resize', listener: () => void) => unknown;
  off: (event: 'resize', listener: () => void) => unknown;
};

// Applied inside Ink's own layout step rather than as a `minHeight` prop: the rows a commit puts
// above the frame are only known once that render is laid out, and by the time an effect could
// lower the prop Ink has already written the commit under the old height, which scrolls the screen
// by the difference for good.
export function installBottomFloor(
  getFrame: () => DOMElement | null,
  stdout: ResizableStdout,
  isReleased: () => boolean,
): () => void {
  const root = getFrame()?.parentNode as InkRoot | undefined;
  const computeLayout = root?.onComputeLayout;
  if (!root || !computeLayout) return () => {};
  let owed = (stdout.rows ?? 1) - 1;
  root.onComputeLayout = () => {
    computeLayout();
    const frame = getFrame()?.yogaNode;
    if (!frame) return;
    const committed = root.staticNode?.yogaNode?.getComputedHeight() ?? 0;
    const rows = stdout.rows ?? 1;
    frame.setMinHeight(isReleased() ? 0 : owedRows(owed, committed, rows));
    computeLayout();
    owed = Math.min(frame.getComputedHeight(), rows - 1);
  };
  // Ink's resize handler lays out and renders without onComputeLayout, so a floor sized for the old
  // viewport would reach the new one's height. Prepended to run before it.
  const onResize = (): void => {
    owed = Math.min(owed, (stdout.rows ?? 1) - 1);
    getFrame()?.yogaNode?.setMinHeight(isReleased() ? 0 : owed);
  };
  stdout.prependListener('resize', onResize);
  return () => {
    root.onComputeLayout = computeLayout;
    stdout.off('resize', onResize);
  };
}
