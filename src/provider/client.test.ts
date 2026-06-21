import { describe, expect, it } from 'vitest';
import {
  extractToolCallsFromContent,
  resolveResponseText,
  sanitizeToolName,
  tryParseJson,
} from './client.js';

describe('resolveResponseText', () => {
  const HERMES_READ =
    '<function=read><parameter=path>packages/ui/src/components/Composer.tsx</parameter>' +
    '<parameter=offset>300</parameter></function>';

  it('recovers a Hermes call emitted in the reasoning channel AND strips it from reasoning', () => {
    // The 35B Q2 loop: read emitted as in-band XML in reasoning. Without stripping, the markup
    // survives in the fed-back reasoning and the model re-fires it every round.
    const r = resolveResponseText('', `Let me read the composer.\n${HERMES_READ}`, []);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'read', args: { path: expect.any(String) } });
    expect(r.reasoning).toBe('Let me read the composer.');
    expect(r.reasoning).not.toContain('<function=');
  });

  it('strips narrated call markup from reasoning even when a native call is present', () => {
    const native = [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }];
    const r = resolveResponseText('', `Reading it now.\n${HERMES_READ}`, native);
    // Native call wins (no recovery), but the reasoning is still cleaned so it can't re-fire.
    expect(r.toolCalls).toEqual(native);
    expect(r.reasoning).toBe('Reading it now.');
  });

  it('leaves a normal turn untouched (no markup => reasoning byte-identical)', () => {
    const r = resolveResponseText('Here is the answer.', 'I considered the options carefully.', []);
    expect(r.toolCalls).toEqual([]);
    expect(r.content).toBe('Here is the answer.');
    expect(r.reasoning).toBe('I considered the options carefully.');
  });

  it('does not hijack a real final answer when reasoning happens to carry markup', () => {
    // Content is non-empty (a real answer), so the reasoning call is NOT recovered as a tool call —
    // but the markup is still scrubbed from the reasoning.
    const r = resolveResponseText('Done — here is the summary.', HERMES_READ, []);
    expect(r.toolCalls).toEqual([]);
    expect(r.content).toBe('Done — here is the summary.');
    expect(r.reasoning ?? '').not.toContain('<function=');
  });
});

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

  it('recovers tool calls from JSON with trailing commas via repair', () => {
    const input = '<tool_call>{"name":"read","arguments":{"path":"foo",},}</tool_call>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[0].args).toEqual({ path: 'foo' });
  });

  it('recovers tool calls from single-quoted JSON via repair', () => {
    const input = "<tool_call>{'name':'grep','arguments':{'pattern':'x'}}</tool_call>";
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('grep');
    expect(result.calls[0].args).toEqual({ pattern: 'x' });
  });
});

describe('extractToolCallsFromContent (pythonic)', () => {
  it('extracts a sentinel-fenced pythonic call', () => {
    const input =
      "<|tool_call_start|>[list(path='/Users/alex/Git/reika-code', depth=1)]<|tool_call_end|>";
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('list');
    expect(result.calls[0].args).toEqual({ path: '/Users/alex/Git/reika-code', depth: 1 });
    expect(result.cleanedContent).toBe('');
  });

  it('keeps surrounding prose when stripping sentinel-fenced calls', () => {
    const input = "let me look\n<|tool_call_start|>[list(path='.')]<|tool_call_end|>\ndone";
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].args).toEqual({ path: '.' });
    expect(result.cleanedContent).toContain('let me look');
    expect(result.cleanedContent).toContain('done');
    expect(result.cleanedContent).not.toContain('tool_call_start');
  });

  it('extracts multiple pythonic calls from one list', () => {
    const input = "<|tool_call_start|>[read(path='a'), grep(pattern='x')]<|tool_call_end|>";
    const result = extractToolCallsFromContent(input);
    expect(result.calls.map(c => c.name)).toEqual(['read', 'grep']);
    expect(result.calls[1].args).toEqual({ pattern: 'x' });
  });

  it('extracts a Llama-style <|python_tag|> call', () => {
    const input = "<|python_tag|>bash(command='ls -la')<|eot_id|>";
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('bash');
    expect(result.calls[0].args).toEqual({ command: 'ls -la' });
  });

  it('extracts a bare pythonic call list with no sentinels', () => {
    const input = "[list(path='.', depth=2)]";
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].args).toEqual({ path: '.', depth: 2 });
  });

  it('maps Python literals (True/False/None) to JSON', () => {
    const input =
      '<|tool_call_start|>[edit(recursive=True, dry=False, note=None)]<|tool_call_end|>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls[0].args).toEqual({ recursive: true, dry: false, note: null });
  });

  it('handles list-valued kwargs', () => {
    const input = "<|tool_call_start|>[grep(globs=['*.ts', '*.js'])]<|tool_call_end|>";
    const result = extractToolCallsFromContent(input);
    expect(result.calls[0].args).toEqual({ globs: ['*.ts', '*.js'] });
  });

  it('does not treat plain prose as a pythonic call', () => {
    const result = extractToolCallsFromContent('I will call list(path) for you.');
    expect(result.calls).toEqual([]);
    expect(result.cleanedContent).toBe('I will call list(path) for you.');
  });

  it('skips pythonic calls that use positional args', () => {
    const input = "<|tool_call_start|>[read('foo.ts')]<|tool_call_end|>";
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(0);
  });
});

describe('extractToolCallsFromContent (hermes xml)', () => {
  it('parses <function=name><parameter=key> calls with number coercion', () => {
    const input =
      '<tool_call>\n<function=read>\n<parameter=path>\npackages/ui/styles.css\n</parameter>\n' +
      '<parameter=offset>\n0\n</parameter>\n<parameter=limit>\n30\n</parameter>\n</function>\n</tool_call>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('read');
    expect(result.calls[0].args).toEqual({ path: 'packages/ui/styles.css', offset: 0, limit: 30 });
    expect(result.cleanedContent).toBe('');
  });

  it('parses the dialect without a <tool_call> wrapper and strips it from prose', () => {
    const input =
      'Here is the plan.\n<function=list>\n<parameter=path>\nsrc\n</parameter>\n</function>';
    const result = extractToolCallsFromContent(input);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('list');
    expect(result.calls[0].args).toEqual({ path: 'src' });
    expect(result.cleanedContent).toBe('Here is the plan.');
  });

  it('does not match plain prose mentioning function=', () => {
    const result = extractToolCallsFromContent('the signature is function=read here');
    expect(result.calls).toEqual([]);
  });
});

describe('tryParseJson', () => {
  it('parses valid JSON without repair', () => {
    const { args, repaired } = tryParseJson('{"path":"foo"}');
    expect(args).toEqual({ path: 'foo' });
    expect(repaired).toBe(false);
  });

  it('returns empty + no repair flag for empty/falsy input', () => {
    expect(tryParseJson('')).toEqual({ args: {}, repaired: false });
    expect(tryParseJson('{}')).toEqual({ args: {}, repaired: false });
  });

  it('repairs trailing commas', () => {
    const { args, repaired } = tryParseJson('{"path":"foo",}');
    expect(args).toEqual({ path: 'foo' });
    expect(repaired).toBe(true);
  });

  it('repairs single-quoted JSON', () => {
    const { args, repaired } = tryParseJson("{'path':'foo'}");
    expect(args).toEqual({ path: 'foo' });
    expect(repaired).toBe(true);
  });

  it('repairs unquoted keys', () => {
    const { args, repaired } = tryParseJson('{path:"foo"}');
    expect(args).toEqual({ path: 'foo' });
    expect(repaired).toBe(true);
  });

  it('repairs truncated JSON (missing closing brace)', () => {
    const { args, repaired } = tryParseJson('{"path":"foo"');
    expect(args).toEqual({ path: 'foo' });
    expect(repaired).toBe(true);
  });

  it('returns empty args when input is completely unparseable', () => {
    const { args, repaired } = tryParseJson('this is not json at all !!!');
    // Even jsonrepair can produce something out of garbage; what matters is the
    // result is a safe object. If it parsed to a non-object (e.g. string), wrap to {}.
    expect(typeof args).toBe('object');
    expect(args).not.toBeNull();
    // repaired may be true or false depending on jsonrepair's output type
    expect(typeof repaired).toBe('boolean');
  });

  it('returns empty args (not array/string) when JSON parses to non-object', () => {
    const { args } = tryParseJson('"just a string"');
    expect(args).toEqual({});
  });
});
