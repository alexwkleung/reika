import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractPlanReferences,
  verifyPlanReferences,
  buildGroundingNote,
  shouldSuppressGrounding,
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
    expect(paths).toEqual(['packages/server/src/http/chat.ts', 'src/atoms/web-search-atoms.ts']);
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
    const { paths } = extractPlanReferences(
      'Add web search to `packages/server/src/http/chat.ts`.',
    );
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

describe('shouldSuppressGrounding', () => {
  const refsOf = (symbols: string[], paths: string[] = []) => ({ symbols, paths });

  it('suppresses when nearly everything is missing (greenfield / external-lib pattern)', () => {
    const refs = refsOf(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const missing = { missingSymbols: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], missingPaths: [] };
    expect(shouldSuppressGrounding(missing, refs)).toBe(true);
  });

  it('keeps the note for a single missing symbol — the high-signal case', () => {
    const refs = refsOf(['A']);
    expect(shouldSuppressGrounding({ missingSymbols: ['A'], missingPaths: [] }, refs)).toBe(false);
  });

  it('keeps the note when a few are missing against a backdrop of many found', () => {
    const refs = refsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
    expect(shouldSuppressGrounding({ missingSymbols: ['a'], missingPaths: [] }, refs)).toBe(false);
    // Half missing still has a backdrop — not suppressed.
    expect(
      shouldSuppressGrounding(
        { missingSymbols: ['a', 'b', 'c', 'd', 'e', 'f'], missingPaths: [] },
        refs,
      ),
    ).toBe(false);
  });

  it('requires both a high fraction AND enough missing — small all-missing plans stay flagged', () => {
    const refs = refsOf(['A', 'B', 'C']);
    // 3/3 missing is 100% but below the absolute floor, so the precise small-plan note survives.
    expect(
      shouldSuppressGrounding({ missingSymbols: ['A', 'B', 'C'], missingPaths: [] }, refs),
    ).toBe(false);
  });

  it('is false when there are no references at all', () => {
    expect(shouldSuppressGrounding({ missingSymbols: [], missingPaths: [] }, refsOf([]))).toBe(
      false,
    );
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

  // Observed: a plan naming `tools/_spill.ts` and `search/_chrome.ts` had both flagged as missing.
  it('resolves a path written from a shorter root, on a segment boundary only', async () => {
    const missing = await verifyPlanReferences(dir, undefined, {
      symbols: [],
      paths: ['service.ts', 'rc/service.ts', 'lib/service.ts'],
    });
    expect(missing.missingPaths).toEqual(['rc/service.ts', 'lib/service.ts']);
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
