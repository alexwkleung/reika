import { describe, expect, it } from 'vitest';
import { ROW_DWELL_MS } from '../../ui/statuspack.js';
import { nextPathLine, PATH_DWELL_MS, PATH_INLINE, pathFits, pathReturnsAt } from './pathdwell.js';

describe('the status path’s line (#948’s rule in the browser)', () => {
  it('dwells as long as the terminal’s status bar does', () => {
    expect(PATH_DWELL_MS).toBe(ROW_DWELL_MS);
  });

  it('goes to its own line at once and comes back only after fitting for the whole dwell', () => {
    let line = nextPathLine(PATH_INLINE, true, 0);
    expect(line.own).toBe(false);
    line = nextPathLine(line, false, 1000);
    expect(line).toEqual({ own: true, unfitAt: 1000 });
    expect(pathReturnsAt(line)).toBe(1000 + PATH_DWELL_MS);
    // A chip shrinking a second later does not bring it back...
    line = nextPathLine(line, true, 2000);
    expect(line.own).toBe(true);
    // ...and growing again restarts the wait.
    line = nextPathLine(line, false, 5000);
    line = nextPathLine(line, true, 5000 + PATH_DWELL_MS - 1);
    expect(line.own).toBe(true);
    line = nextPathLine(line, true, 5000 + PATH_DWELL_MS);
    expect(line.own).toBe(false);
    expect(pathReturnsAt(line)).toBeNull();
  });

  it('fits when the chips, the gap and the path fit the strip', () => {
    expect(pathFits(500, 300, 180, 18)).toBe(true);
    expect(pathFits(500, 300, 190, 18)).toBe(false);
  });
});
