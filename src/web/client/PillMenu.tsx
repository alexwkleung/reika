import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { tip } from './Tooltip.js';

// A pill in the input box that opens a menu above it: the mode and the model. A real button and
// real menu items, so it works from the keyboard as well as the mouse.

export type PillOption = {
  value: string;
  label: string;
  detail?: string | null;
  // A CSS color for the dot before the label (the mode's own color).
  dot?: string;
  checked: boolean;
};

export function PillMenu({
  label,
  dot,
  options,
  onPick,
  disabled,
  title,
  ariaLabel,
}: {
  label: ReactNode;
  dot?: string;
  options: PillOption[];
  onPick: (value: string) => void;
  disabled: boolean;
  // Why it is disabled, shown on hover.
  title?: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [quiet, setQuiet] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const popover = useRef<HTMLDivElement>(null);
  // Set on open, cleared once the first focus lands: that focus must not scroll.
  const opening = useRef(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  // The checked option is scrolled to before the first paint: scrolled after it, by the focus below,
  // the menu visibly moved. macOS still flashes an overlay scrollbar for that scroll, paint or not,
  // so the scrollbar stays hidden until the user scrolls or moves by key (`quiet`).
  useLayoutEffect(() => {
    const menu = popover.current;
    const item = items.current[active];
    if (!open || !menu || !item) return;
    opening.current = true;
    if (item.offsetTop + item.offsetHeight > menu.clientHeight) {
      menu.scrollTop = item.offsetTop - (menu.clientHeight - item.offsetHeight) / 2;
    }
    // Only on open; arrow keys after it scroll as focus moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    const item = items.current[active];
    if (!open || !item) return;
    item.focus({ preventScroll: true });
    if (opening.current) opening.current = false;
    else item.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  // A switch elsewhere (another tab, a turn starting) can disable the pill while its menu is open.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const show = () => {
    setActive(
      Math.max(
        0,
        options.findIndex(o => o.checked),
      ),
    );
    setQuiet(true);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const pick = (value: string) => {
    close();
    onPick(value);
  };
  const onMenuKey = (e: KeyboardEvent) => {
    setQuiet(false);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(i => (i + step + options.length) % options.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="pill-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="pill"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        {...tip(disabled ? title : null)}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={e => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            show();
          }
        }}
      >
        {dot ? <span className="pill-dot" style={{ background: dot }} aria-hidden="true" /> : null}
        <span className="pill-text">{label}</span>
        <svg className="pill-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
      {open ? (
        <div
          ref={popover}
          className={quiet ? 'pill-popover pill-popover--quiet' : 'pill-popover'}
          role="menu"
          id={menuId}
          onKeyDown={onMenuKey}
          onWheel={() => setQuiet(false)}
          onTouchMove={() => setQuiet(false)}
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={el => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={o.checked}
              tabIndex={i === active ? 0 : -1}
              className="pill-option"
              onClick={() => pick(o.value)}
              onMouseEnter={() => setActive(i)}
            >
              {o.dot ? (
                <span className="pill-dot" style={{ background: o.dot }} aria-hidden="true" />
              ) : null}
              <span className="pill-option-label">{o.label}</span>
              {o.detail ? <span className="pill-option-detail">{o.detail}</span> : null}
              {o.checked ? (
                <svg className="pill-check" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m2.5 6.5 2.5 2.5 4.5-5" />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
