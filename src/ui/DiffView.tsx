import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import { theme } from './theme.js';

export function DiffView({ diff, path }: { diff: string; path: string }) {
  const lang = detectLanguage(path);
  const lines = diff.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} language={lang} />
      ))}
    </>
  );
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+ ')) added++;
    else if (line.startsWith('- ')) removed++;
  }
  return { added, removed };
}

function DiffLine({ line, language }: { line: string; language: string }) {
  if (line.startsWith('+ ')) {
    const code = line.slice(2);
    return (
      <Box>
        <Text color={theme.success}>{'+ '}</Text>
        <Text>{safeHighlight(code, language)}</Text>
      </Box>
    );
  }
  if (line.startsWith('- ')) {
    const code = line.slice(2);
    return (
      <Box>
        <Text color={theme.error}>{'- '}</Text>
        <Text>{safeHighlight(code, language)}</Text>
      </Box>
    );
  }
  const code = line.startsWith('  ') ? line.slice(2) : line;
  return (
    <Box>
      <Text>{'  '}</Text>
      <Text color={theme.muted}>{code}</Text>
    </Box>
  );
}

function safeHighlight(code: string, language: string): string {
  if (!code.trim()) return code;
  try {
    return highlight(code, { language, ignoreIllegals: true });
  } catch {
    return code;
  }
}

function detectLanguage(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'rb':
      return 'ruby';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'html':
    case 'htm':
      return 'html';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sh':
    case 'bash':
      return 'bash';
    case 'toml':
      return 'ini';
    default:
      return 'plaintext';
  }
}
