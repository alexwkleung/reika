import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractPlanReferences,
  verifyPlanReferences,
  buildGroundingNote,
} from './groundcheck.js';

describe('extractPlanReferences', () => {
  it('pulls code-y identifiers from inline backticks, skipping prose words', () => {
    const plan =
      '1. In the composer, call `streamUnifiedAsk` when `forceWebSearch` is `true` and the toggle ' +
      'is `enabled`. Render `WebSearchToggle`.';
    const { symbols } = extractPlanReferences(plan);
    expect(symbols).toContain('streamUnifiedAsk');
    expect(symbols).toContain('forceWebSearch');
    expect(symbols).toContain('WebSearchToggle');
    // plain English backticked words are not treated as symbols
    expect(symbols).not.toContain('true');
    expect(symbols).not.toContain('enabled');
  });

  it('classifies path-like backticks as paths', () => {
    const { paths, symbols } = extractPlanReferences(
      'Edit `packages/server/src/http/chat.ts` and `src/atoms/web-search-atoms.ts`.',
    );
    expect(paths).toEqual([
      'packages/server/src/http/chat.ts',
      'src/atoms/web-search-atoms.ts',
    ]);
    expect(symbols).toHaveLength(0);
  });

  it('tokenizes qualified/called references into identifiers', () => {
    const { symbols } = extractPlanReferences('Call `chatStore.sendMessage()` then `useChat()`.');
    expect(symbols).toContain('chatStore');
    expect(symbols).toContain('sendMessage');
    expect(symbols).toContain('useChat');
  });

  it('ignores identifiers inside fenced code blocks (snippet noise)', () => {
    const plan = 'Add this:\n```ts\nconst incidentalHelper = 1\n```\nthen call `realTarget`.';
    const { symbols } = extractPlanReferences(plan);
    expect(symbols).toContain('realTarget');
    expect(symbols).not.toContain('incidentalHelper');
  });

  it('dedupes and is order-stable', () => {
    const { symbols } = extractPlanReferences('`fooBar` then `fooBar` then `bazQux`');
    expect(symbols).toEqual(['fooBar', 'bazQux']);
  });

  it('suppresses create-intent and test-file paths (planned new files are not flagged)', () => {
    const plan =
      '1. Create a module in `packages/core/src/syntax-highlight.ts` that does X.\n' +
      '5. Add tests in `packages/core/src/__tests__/syntax-highlight.test.ts`.';
    const { paths } = extractPlanReferences(plan);
    expect(paths).toEqual([]); // both are new files the plan creates
  });

  it('still flags a modify-target path — "add X to foo.ts" must not be suppressed', () => {
    // This is the failed-edit loop case: a hallucinated existing file must still surface.
    const { paths } = extractPlanReferences('Add web search to `packages/server/src/http/chat.ts`.');
    expect(paths).toEqual(['packages/server/src/http/chat.ts']);
  });

  it('keeps flagging symbols regardless of create-intent verbs on the line', () => {
    const { symbols } = extractPlanReferences('Create a helper that calls `resultsOverlayRef`.');
    expect(symbols).toContain('resultsOverlayRef');
  });
});

describe('buildGroundingNote', () => {
  it('is empty when nothing is missing', () => {
    expect(buildGroundingNote({ missingSymbols: [], missingPaths: [] })).toBe('');
  });

  it('lists missing refs with a verify-not-loop framing', () => {
    const note = buildGroundingNote({
      missingSymbols: ['streamUnifiedAsk'],
      missingPaths: ['src/gone.ts'],
    });
    expect(note).toContain('streamUnifiedAsk');
    expect(note).toContain('src/gone.ts');
    expect(note).toContain('not found');
    expect(note).toContain('do not loop');
    // Items are backticked so markdown rendering won't mangle underscores/asterisks.
    expect(note).toContain('`streamUnifiedAsk`');
    expect(note).toContain('`src/gone.ts`');
  });
});

describe('verifyPlanReferences', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reika-ground-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'service.ts'),
      'export function realTarget() {}\nconst forceWebSearch = false\n',
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags symbols and paths that do not exist, leaves real ones alone', async () => {
    const missing = await verifyPlanReferences(dir, undefined, {
      symbols: ['realTarget', 'forceWebSearch', 'streamUnifiedAsk'],
      paths: ['src/service.ts', 'src/gone.ts'],
    });
    expect(missing.missingSymbols).toEqual(['streamUnifiedAsk']);
    expect(missing.missingPaths).toEqual(['src/gone.ts']);
  });

  it('uses word boundaries — a substring of a real symbol still reads as missing', async () => {
    // `realTarg` is a substring of realTarget but not its own token, so it must be flagged.
    const missing = await verifyPlanReferences(dir, undefined, {
      symbols: ['realTarg'],
      paths: [],
    });
    expect(missing.missingSymbols).toEqual(['realTarg']);
  });
});
