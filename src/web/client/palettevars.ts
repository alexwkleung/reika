import { palette } from '../../display/palette.js';

// The palette as `--reika-<slot>` variables (`modePlan` → `--reika-mode-plan`), set on the root
// before the first render. app.css keeps only the page's own values, so the TUI and the page cannot
// drift apart on a shared slot.
export function paletteVars(): [name: string, value: string][] {
  return Object.entries(palette).map(([slot, hex]) => [
    `--reika-${slot.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`,
    hex,
  ]);
}

export function applyPalette(style: Pick<CSSStyleDeclaration, 'setProperty'>): void {
  for (const [name, value] of paletteVars()) style.setProperty(name, value);
}
