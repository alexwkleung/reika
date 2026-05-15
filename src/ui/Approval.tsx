import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import type { ApprovalRequest } from '../types.js';

export const APPROVAL_OPTIONS = ['Approve', 'Decline', 'Always (this session)'] as const;
export type ApprovalChoice = 0 | 1 | 2;

export function Approval({
  request,
  selectedIndex,
}: {
  request: ApprovalRequest;
  selectedIndex: number;
}) {
  const isCommand = request.tool === 'bash';
  return (
    <Box
      borderStyle="round"
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{`${request.tool}  ${request.subject}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {isCommand ? (
          <CommandPreview command={request.preview} />
        ) : (
          <DiffPreview diff={request.preview} path={request.subject} />
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((label, i) => (
          <Text key={i} bold={i === selectedIndex}>
            {`${i === selectedIndex ? '› ' : '  '}${label}`}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {'↑↓ navigate  ·  enter select  ·  y/n shortcuts  ·  ctrl-c abort'}
        </Text>
      </Box>
    </Box>
  );
}

function DiffPreview({ diff, path }: { diff: string; path: string }) {
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

function CommandPreview({ command }: { command: string }) {
  const lines = command.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="green">{i === 0 ? '$ ' : '  '}</Text>
          <Text>{safeHighlight(line, 'bash')}</Text>
        </Box>
      ))}
    </>
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
