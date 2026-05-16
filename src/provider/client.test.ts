import { describe, expect, it } from 'vitest';
import { extractToolCallsFromContent, sanitizeToolName } from './client.js';

describe('sanitizeToolName', () => {
  it('returns clean names unchanged', () => {
    expect(sanitizeToolName('read')).toBe('read');
    expect(sanitizeToolName('list_files')).toBe('list_files');
  });

  it('strips Harmony channel markers', () => {
    expect(sanitizeToolName('grep<|channel|>commentary')).toBe('grep');
    expect(sanitizeToolName('read<|channel|>analysis')).toBe('read');
  });

  it('strips arbitrary chat-template tokens', () => {
    expect(sanitizeToolName('bash<|im_end|>')).toBe('bash');
    expect(sanitizeToolName('edit<|something|>more text')).toBe('edit');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeToolName('  read  ')).toBe('read');
  });
});

describe('extractToolCallsFromContent', () => {
  it('returns no calls and unchanged content when no XML present', () => {
    const result = extractToolCallsFromContent('just plain text');
    expect(result.calls).toEqual([]);
    expect(result.cleanedContent).toBe('just plain text');
  });

  it('extracts a single tool call and strips it from content', () => {
    const input = 'before <tool_call>{"name":"read","arguments":{"path":"foo"}}</tool_call> after';
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[0].args).toEqual({ path: 'foo' });
    expect(result.cleanedContent).not.toContain('<tool_call>');
  });

  it('accepts `args` key as alias for `arguments`', () => {
    const input = '<tool_call>{"name":"grep","args":{"pattern":"x"}}</tool_call>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls[0].args).toEqual({ pattern: 'x' });
  });

  it('extracts multiple tool calls', () => {
    const input =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{}}</tool_call>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(2);
    expect(result.calls.map(c => c.name)).toEqual(['a', 'b']);
  });

  it('skips malformed JSON inside tool_call blocks', () => {
    const input = '<tool_call>{not json}</tool_call><tool_call>{"name":"ok"}</tool_call>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('ok');
  });

  it('skips tool_call blocks without a name', () => {
    const input = '<tool_call>{"arguments":{}}</tool_call>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(0);
  });

  it('assigns each extracted call a unique id', () => {
    const input = '<tool_call>{"name":"a"}</tool_call><tool_call>{"name":"b"}</tool_call>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls[0].id).not.toBe(result.calls[1].id);
  });
});
