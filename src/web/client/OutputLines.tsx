import './output.css';

// Command output wraps, as the terminal's does: a log line's end is usually the part that says what
// went wrong, and a sideways scroller hides it from anyone without a trackpad. One block per line,
// so a wrapped line's continuation hangs under it instead of reading as a line of its own. Each
// keeps its newline (a block's trailing one draws nothing), so a copy is the output byte for byte.
export function OutputLines({ text, className }: { text: string; className: string }) {
  const lines = text.split('\n');
  return (
    <pre className={`${className} output-lines`}>
      {lines.map((line, i) => (
        <span key={i} className="output-line">
          {i < lines.length - 1 ? `${line}\n` : line}
        </span>
      ))}
    </pre>
  );
}
