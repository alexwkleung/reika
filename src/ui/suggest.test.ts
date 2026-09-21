import { describe, expect, it } from 'vitest';
import { acceptSuggestion, computeSuggestions } from './suggest.js';

const FILE_INDEX = [
  'src/agent/loop.ts',
  'src/agent/prompt.ts',
  'src/ui/App.tsx',
  'src/ui/Approval.tsx',
  'src/types.ts',
  'README.md',
];

describe('computeSuggestions — commands', () => {
  it('returns all commands when value is just /', () => {
    const state = computeSuggestions('/', FILE_INDEX);
    expect(state?.kind).toBe('command');
    expect((state?.items.length ?? 0) > 5).toBe(true);
  });

  it('filters commands by prefix', () => {
    const state = computeSuggestions('/cl', FILE_INDEX);
    expect(state?.kind).toBe('command');
    const names = state?.items.map(i => i.value) ?? [];
    expect(names).toContain('/clear');
    expect(names).not.toContain('/help');
  });

  it('returns null when value has a space (command argument territory)', () => {
    const state = computeSuggestions('/cd somepath', FILE_INDEX);
    expect(state).toBeNull();
  });

  it('includes skills alongside built-in commands', () => {
    const skills = [
      { name: 'review', description: 'review the branch' },
      { name: 'deploy', description: 'deploy to staging' },
    ];
    const state = computeSuggestions('/', FILE_INDEX, skills);
    const names = state?.items.map(i => i.value) ?? [];
    expect(names).toContain('/review');
    expect(names).toContain('/deploy');
    expect(names).toContain('/help'); // built-ins still present
  });

  it('built-in commands shadow skills with the same name', () => {
    const skills = [{ name: 'help', description: 'shadowed' }];
    const state = computeSuggestions('/h', FILE_INDEX, skills);
    const items = state?.items ?? [];
    const helpItems = items.filter(i => i.value === '/help');
    expect(helpItems).toHaveLength(1);
    expect(helpItems[0].display).not.toContain('shadowed');
  });

  it('skill prefix filter works the same as commands', () => {
    const skills = [
      { name: 'review', description: 'r' },
      { name: 'deploy', description: 'd' },
    ];
    const state = computeSuggestions('/rev', FILE_INDEX, skills);
    const names = state?.items.map(i => i.value) ?? [];
    expect(names).toContain('/review');
    expect(names).not.toContain('/deploy');
  });
});

describe('computeSuggestions — /model arguments', () => {
  const TARGETS = [
    { name: 'qwen2.5-coder', model: 'Qwen2.5-Coder' },
    { name: 'glm-4', model: 'GLM-4' },
    { name: 'big', model: 'deepseek-chat' },
    { name: 'muse-spark', model: 'Muse-Spark', group: 'go' },
  ];

  it('lists all targets after "/model "', () => {
    const state = computeSuggestions('/model ', [], [], TARGETS);
    expect(state?.kind).toBe('command');
    expect(state?.items.map(i => i.value)).toEqual([
      '/model qwen2.5-coder',
      '/model glm-4',
      '/model big',
      '/model muse-spark',
    ]);
  });

  it('filters by name prefix', () => {
    const state = computeSuggestions('/model gl', [], [], TARGETS);
    expect(state?.items.map(i => i.value)).toEqual(['/model glm-4']);
  });

  it('matches the model a profile points at, not just its name', () => {
    const state = computeSuggestions('/model deep', [], [], TARGETS);
    expect(state?.items.map(i => i.value)).toEqual(['/model big']);
  });

  it('shows the mapping only when the name does not spell the model', () => {
    const state = computeSuggestions('/model ', [], [], TARGETS);
    const displays = state?.items.map(i => i.display) ?? [];
    expect(displays).toContain('/model qwen2.5-coder');
    expect(displays).toContain('/model big  —  deepseek-chat');
    expect(displays).toContain('/model muse-spark  (go)');
  });

  it("matches a named profile's extra models on the profile name", () => {
    const state = computeSuggestions('/model go', [], [], TARGETS);
    expect(state?.items.map(i => i.value)).toEqual(['/model muse-spark']);
  });

  it('returns null with no match or a second argument', () => {
    expect(computeSuggestions('/model xyzzy', [], [], TARGETS)).toBeNull();
    expect(computeSuggestions('/model glm-4 extra', [], [], TARGETS)).toBeNull();
  });

  it('a newline is a multi-line buffer, not an argument separator', () => {
    expect(computeSuggestions('/model\n', [], [], TARGETS)).toBeNull();
  });

  it('accept replaces the whole line with the completed command', () => {
    const state = computeSuggestions('/model gl', [], [], TARGETS);
    const next = acceptSuggestion('/model gl', state!.items[0], state!.partial);
    expect(next).toBe('/model glm-4');
  });
});

describe('computeSuggestions — file mentions', () => {
  it('returns file suggestions for trailing @', () => {
    const state = computeSuggestions('look at @', FILE_INDEX);
    expect(state?.kind).toBe('file');
    expect((state?.items.length ?? 0) > 0).toBe(true);
  });

  it('prefers basename-startsWith matches', () => {
    const state = computeSuggestions('@App', FILE_INDEX);
    const top = state?.items[0]?.value;
    expect(top).toBe('@src/ui/App.tsx');
  });

  it('returns null when nothing matches', () => {
    const state = computeSuggestions('@xyzzy123', FILE_INDEX);
    expect(state).toBeNull();
  });

  it('matches by basename substring (case-insensitive)', () => {
    const state = computeSuggestions('@approval', FILE_INDEX);
    const names = state?.items.map(i => i.value) ?? [];
    expect(names).toContain('@src/ui/Approval.tsx');
  });

  it('returns null when there is no @ at end of input', () => {
    const state = computeSuggestions('plain text', FILE_INDEX);
    expect(state).toBeNull();
  });
});

describe('acceptSuggestion', () => {
  it('replaces the partial with the chosen value', () => {
    const next = acceptSuggestion(
      'look at @App',
      { value: '@src/ui/App.tsx', display: 'src/ui/App.tsx' },
      '@App',
    );
    expect(next).toBe('look at @src/ui/App.tsx');
  });

  it('handles command completion', () => {
    const next = acceptSuggestion('/cl', { value: '/clear', display: '/clear' }, '/cl');
    expect(next).toBe('/clear');
  });
});
