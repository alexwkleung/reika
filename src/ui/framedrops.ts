import { debugLog } from '../debug.js';

// Input-jump measurement (REIKA_DEBUG only). Ink anchors the live frame to the cursor, so a frame
// that erases more rows than it prints back leaves the input box higher with blank rows under it,
// and the next stream pushes it back down. Read off the bytes the terminal actually gets, because
// that is the only place a commit's static rows and the redrawn frame are counted together.

const CURSOR_UP = '\x1b[1A';
const CLEAR_SCREEN = '\x1b[2J';

// Rows the cursor ended above where it started: Ink erases with one cursor-up per row and prints
// with newlines, so the difference is how far the input box moved up. Null for a full-screen
// repaint, which homes the cursor instead and says nothing about the frame it replaced.
export function frameRise(frame: string): number | null {
  if (frame.includes(CLEAR_SCREEN)) return null;
  let up = 0;
  for (let i = frame.indexOf(CURSOR_UP); i !== -1; i = frame.indexOf(CURSOR_UP, i + 1)) up++;
  let down = 0;
  for (let i = frame.indexOf('\n'); i !== -1; i = frame.indexOf('\n', i + 1)) down++;
  return Math.max(0, up - down);
}

// What the App was drawing, noted each render, so a drop can name the change that caused it.
let current = '';
let previous = '';

export function noteFrameState(state: string): void {
  current = state;
}

export function recordFrame(frame: string): void {
  const rise = frameRise(frame);
  if (rise !== null && rise > 0) {
    debugLog(`frame-drop rows=${rise} from="${previous}" to="${current}"`);
  }
  previous = current;
}
