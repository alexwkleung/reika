import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  useEffect(() => {
    if (open) items.current[active]?.focus();
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
        <div className="pill-popover" role="menu" id={menuId} onKeyDown={onMenuKey}>
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
