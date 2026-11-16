import { useEffect, useRef } from 'react';
import './imagepreview.css';

// An attached image at full size, over the page (#979). Opened from a chip's thumbnail; Esc, the
// backdrop or the close button shut it, and the box gets focus back.
export function ImagePreview({
  src,
  caption,
  onClose,
}: {
  src: string;
  caption: string;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  // Held, not a dependency: the composer re-renders as a turn streams, and the effect would take
  // focus back each time.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The box's own Esc stops a running turn; this one only closes the preview.
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div
      className="image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={caption}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <figure className="image-preview-figure">
        <img className="image-preview-img" src={src} alt={caption} />
        <figcaption className="image-preview-caption">{caption}</figcaption>
      </figure>
      <button
        ref={close}
        type="button"
        className="image-preview-close"
        aria-label="Close preview"
        onClick={onClose}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
