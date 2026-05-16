import { COMMANDS } from './commands.js';

export type Suggestion = {
  value: string;
  display: string;
};

export type SuggestionState = {
  kind: 'command' | 'file';
  items: Suggestion[];
  partial: string;
};

const MAX_FILE_SUGGESTIONS = 8;

export function computeSuggestions(value: string, fileIndex: string[]): SuggestionState | null {
  if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
    const partial = value.slice(1).toLowerCase();
    const items: Suggestion[] = COMMANDS.filter(c => c.name.startsWith(partial)).map(c => ({
      value: `/${c.name}`,
      display: `/${c.name}  —  ${c.desc}`,
    }));
    if (items.length === 0) return null;
    return { kind: 'command', items, partial: value };
  }

  const mention = /@(\S*)$/.exec(value);
  if (mention) {
    const partial = mention[1];
    const matched = matchFiles(fileIndex, partial);
    if (matched.length === 0) return null;
    return {
      kind: 'file',
      items: matched.map(f => ({ value: `@${f}`, display: f })),
      partial: '@' + partial,
    };
  }

  return null;
}

export function acceptSuggestion(value: string, selected: Suggestion, partial: string): string {
  return value.slice(0, value.length - partial.length) + selected.value;
}

function matchFiles(files: string[], partial: string): string[] {
  if (!partial) return files.slice(0, MAX_FILE_SUGGESTIONS);
  const lower = partial.toLowerCase();
  type Hit = { file: string; score: number };
  const hits: Hit[] = [];
  for (const file of files) {
    const baseStart = file.lastIndexOf('/') + 1;
    const basename = file.slice(baseStart).toLowerCase();
    const fullLower = file.toLowerCase();
    let score = 0;
    if (basename.startsWith(lower)) score = 3;
    else if (basename.includes(lower)) score = 2;
    else if (fullLower.includes(lower)) score = 1;
    if (score > 0) hits.push({ file, score });
    if (hits.length >= 200) break;
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return hits.slice(0, MAX_FILE_SUGGESTIONS).map(h => h.file);
}
