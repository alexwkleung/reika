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

export type SkillEntry = { name: string; description: string };

// A switchable /model argument: the profile key the command accepts plus the
// model it resolves to (shown when the key alone doesn't say — named profiles,
// 'default'). Structurally a subset of models.ts's ModelTarget so App can pass
// those straight through.
export type ModelSuggestTarget = { name: string; model: string };

export function computeSuggestions(
  value: string,
  fileIndex: string[],
  skills: SkillEntry[] = [],
  modelTargets: ModelSuggestTarget[] = [],
): SuggestionState | null {
  if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
    const partial = value.slice(1).toLowerCase();
    const builtIns = COMMANDS.filter(c => c.name.startsWith(partial)).map(c => ({
      value: `/${c.name}`,
      display: `/${c.name}  —  ${c.desc}`,
    }));
    const builtInNames = new Set(COMMANDS.map(c => c.name));
    const skillItems = skills
      .filter(s => !builtInNames.has(s.name) && s.name.startsWith(partial))
      .map(s => ({
        value: `/${s.name}`,
        display: `/${s.name}  —  ${s.description}`,
      }));
    const items: Suggestion[] = [...builtIns, ...skillItems];
    if (items.length === 0) return null;
    return { kind: 'command', items, partial: value };
  }

  // `/model <partial>` completes against switchable model/profile names. The
  // match is anchored to a single argument so `/model qwen extra` gets no menu,
  // and spaces only — a pasted newline is a multi-line buffer, not an argument.
  const modelArg = /^\/model +(\S*)$/i.exec(value);
  if (modelArg) {
    const partial = modelArg[1].toLowerCase();
    const items = modelTargets
      .filter(t => t.name.startsWith(partial) || t.model.toLowerCase().startsWith(partial))
      .map(t => ({
        value: `/model ${t.name}`,
        // Auto-registered model entries have name === lowercased model — the
        // mapping suffix would just repeat the key, so it's only shown when
        // the name doesn't already say which model you'd get.
        display:
          t.name === t.model.toLowerCase() ? `/model ${t.name}` : `/model ${t.name}  —  ${t.model}`,
      }));
    if (items.length === 0) return null;
    // partial = the whole value: acceptSuggestion replaces the full line with
    // the completed command.
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
