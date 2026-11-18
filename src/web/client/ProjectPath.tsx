import { tip } from './Tooltip.js';

// The project folder by its own name, the full path on hover: the third piece of what the next
// message runs against, beside the mode and the model.
export function ProjectPath({ path }: { path: string }) {
  const name = path.replace(/\/+$/, '').split('/').pop() || path;
  return (
    <span className="composer-folder" {...tip(path)}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
      </svg>
      <span className="composer-folder-name">{name}</span>
    </span>
  );
}
