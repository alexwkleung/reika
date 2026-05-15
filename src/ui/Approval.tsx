import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import type { ApprovalRequest } from '../types.js';

export function Approval({ request }: { request: ApprovalRequest }) {
  const lang = detectLanguage(request.path);
  const lines = request.diff.split('\n');
  return (
    <Box
      borderStyle="round"
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{`${request.tool}  ${request.path}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => (
          <DiffLine key={i} line={line} language={lang} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{'[y] approve  ·  [n] decline  ·  ctrl-c abort'}</Text>
      </Box>
    </Box>
  );
}

function DiffLine({ line, language }: { line: string; language: string }) {
  if (line.startsWith('+ ')) {
    const code = line.slice(2);
    return (
      <Box>
        <Text color="green">{'+ '}</Text>
        <Text>{safeHighlight(code, language)}</Text>
      </Box>
    );
  }
  if (line.startsWith('- ')) {
    const code = line.slice(2);
    return (
      <Box>
        <Text color="red">{'- '}</Text>
        <Text>{safeHighlight(code, language)}</Text>
      </Box>
    );
  }
  const code = line.startsWith('  ') ? line.slice(2) : line;
  return (
    <Box>
      <Text>{'  '}</Text>
      <Text dimColor>{code}</Text>
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
