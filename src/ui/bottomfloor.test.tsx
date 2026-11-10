import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import React, { useLayoutEffect, useRef } from 'react';
import type { DOMElement } from 'ink';
import { frameRise } from './framedrops.js';
import { createSyncedStdout } from './syncframe.js';
import { inputFloorEnabled, installBottomFloor, owedRows } from './bottomfloor.js';

// Ink stops erasing the live frame when CI is set (read once at import), so every rise would be 0.
const ciEnv = process.env.CI;
process.env.CI = 'false';
const { Box, Static, Text, render } = await import('ink');
afterAll(() => {
  if (ciEnv === undefined) delete process.env.CI;
  else process.env.CI = ciEnv;
});

class Out extends EventEmitter {
  writes: string[] = [];
  columns = 60;
  rows = 20;
  isTTY = true;
  write = (frame: string): boolean => {
    this.writes.push(frame);
    return true;
  };
}

const tick = (ms = 50): Promise<void> => new Promise(r => setTimeout(r, ms));
const plain = (frame: string): string => frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

// A terminal's worth of bookkeeping: the row the cursor rests on after each frame, counted from
// where the app started and clamped to the viewport the way scrolling clamps it.
function cursorRows(writes: string[], rows: number): number[] {
  let row = 1;
  return writes.map(w => {
    const up = w.split('\x1b[1A').length - 1;
    const down = w.split('\n').length - 1;
    row = Math.min(rows, Math.max(1, row - up) + down);
    return row;
  });
}

function Harness({ items, live, floor }: { items: string[]; live: number; floor: boolean }) {
  const frame = useRef<DOMElement>(null);
  const out = useRef<Out | null>(null);
  useLayoutEffect(() => {
    if (!floor || !out.current) return;
    return installBottomFloor(
      () => frame.current,
      out.current,
      () => false,
    );
  }, [floor]);
  return (
    <OutContext.Consumer>
      {o => {
        out.current = o;
        return (
          <Box ref={frame} flexDirection="column">
            <Static items={items}>{(item, i) => <Text key={i}>{item}</Text>}</Static>
            {Array.from({ length: live }, (_, i) => (
              <Text key={i}>live {i}</Text>
            ))}
            <Box flexGrow={1} />
            <Text>INPUT</Text>
          </Box>
        );
      }}
    </OutContext.Consumer>
  );
}
const OutContext = React.createContext<Out | null>(null);

async function drive(floor: boolean) {
  const out = new Out();
  const view = (items: string[], live: number) => (
    <OutContext.Provider value={out}>
      <Harness items={items} live={live} floor={floor} />
    </OutContext.Provider>
  );
  const app = render(view([], 0), {
    stdout: createSyncedStdout(out as never, {}),
    stderr: new Out() as never,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const steps: [string[], number][] = [
    [[], 0],
    [[], 6],
    [['a', 'b', 'c'], 2],
    [['a', 'b', 'c'], 0],
    [['a', 'b', 'c', 'd'], 8],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q'], 1],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q'], 0],
  ];
  for (const [items, live] of steps) {
    app.rerender(view(items, live));
    await tick();
  }
  app.unmount();
  return out;
}

describe('owedRows', () => {
  it('pays the floor off by what commits and stays under the viewport', () => {
    expect(owedRows(19, 0, 20)).toBe(19);
    expect(owedRows(19, 5, 20)).toBe(14);
    expect(owedRows(3, 9, 20)).toBe(0);
    expect(owedRows(30, 0, 20)).toBe(19);
  });
});

describe('inputFloorEnabled', () => {
  it('needs a sized terminal and honors the kill switch', () => {
    expect(inputFloorEnabled({ rows: 40, isTTY: true }, {})).toBe(true);
    expect(inputFloorEnabled({ rows: 40, isTTY: true }, { REIKA_INPUT_FLOOR: '0' })).toBe(false);
    expect(inputFloorEnabled({ isTTY: true }, {})).toBe(false);
    expect(inputFloorEnabled({ rows: 40 }, {})).toBe(false);
  });
});

describe('bottom floor', () => {
  it('keeps the frame on the last row through commits and shrinking live content', async () => {
    const out = await drive(true);
    // The first frame is the unfloored mount; every one after it ends on the bottom row.
    const rested = cursorRows(out.writes, out.rows).slice(1, -1);
    expect(rested.length).toBeGreaterThan(4);
    for (const row of rested) expect(row).toBe(out.rows);
    for (const w of out.writes.slice(1, -1)) {
      expect(frameRise(w)).toBe(0);
      expect(w).not.toContain('\x1b[2J');
      expect(plain(w).trimEnd().endsWith('INPUT')).toBe(true);
    }
  });

  it('without it the same run leaves the frame short of the bottom', async () => {
    const out = await drive(false);
    expect(out.writes.some(w => (frameRise(w) ?? 0) > 0)).toBe(true);
  });
});
