import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './tooltip.css';

// The page's tooltips, drawn by one layer instead of the browser's `title`, which looks like a web
// page and cannot be styled. An element opts in with `tip()`: `data-tip` for the layer to draw and
// `aria-description` for a screen reader, which hears it the way it would a title. Delegated from
// the document, so a button in a flex row needs no wrapper around it to have one.

// Hover waits a moment, as a native app's does; once one tip has shown, the next comes at once.
export const TIP_DELAY_MS = 500;
const TIP_WARM_MS = 400;
const GAP = 6;
const EDGE = 8;

// `cut`: shown only when that descendant (or the element itself, for '') is cut off by its
// ellipsis. `aria: false` for a tip that only repeats the element's own name (an icon button's
// aria-label), which a screen reader would otherwise read twice; a cut tip never adds one either.
export function tip(
  text: string | null | undefined,
  opts: { cut?: string; aria?: boolean } = {},
): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = { 'data-tip': text };
  if (opts.cut !== undefined) out['data-tip-cut'] = opts.cut;
  else if (opts.aria !== false) out['aria-description'] = text;
  return out;
}

function isCut(el: HTMLElement): boolean {
  const selector = el.dataset.tipCut;
  if (selector === undefined) return true;
  const target = selector ? el.querySelector<HTMLElement>(selector) : el;
  return !!target && target.scrollWidth > target.clientWidth + 1;
}

// Where the bubble goes: above the element, centred and held inside the window, or below it when
// there is no room above.
export function placeTip(
  anchor: { left: number; top: number; bottom: number; width: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(EDGE, Math.min(centred, viewport.width - size.width - EDGE));
  const above = anchor.top - GAP - size.height;
  return { left, top: above >= EDGE ? above : anchor.bottom + GAP };
}

export function TooltipLayer() {
  const [shown, setShown] = useState<{ el: HTMLElement; text: string } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHidden = useRef(0);

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const hide = () => {
      clear();
      if (current.current) lastHidden.current = Date.now();
      current.current = null;
      setShown(null);
    };
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text || !el.isConnected || !isCut(el)) return;
      setShown({ el, text });
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
      if (el === current.current) return;
      hide();
      if (!el) return;
      current.current = el;
      const warm = Date.now() - lastHidden.current < TIP_WARM_MS;
      if (warm) show(el);
      else timer.current = setTimeout(() => show(el), TIP_DELAY_MS);
    };
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
      hide();
      // Keyboard focus only: a click focuses its button too, and a tip there gets in the way.
      if (!el || !el.matches(':focus-visible')) return;
      current.current = el;
      show(el);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      clear();
      document.removeEventListener('mouseover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    const box = bubble.current;
    if (!shown || !box) return;
    const r = shown.el.getBoundingClientRect();
    const at = placeTip(
      r,
      { width: box.offsetWidth, height: box.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    box.style.left = `${at.left}px`;
    box.style.top = `${at.top}px`;
    box.dataset.placed = 'true';
  }, [shown]);

  if (!shown) return null;
  // aria-hidden: the element's own aria-description already says this to a screen reader.
  return createPortal(
    <div ref={bubble} className="tip" aria-hidden="true">
      {shown.text}
    </div>,
    document.body,
  );
}
