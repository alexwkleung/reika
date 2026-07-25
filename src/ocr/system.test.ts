import { describe, expect, it } from 'vitest';
import { parseWorkerResult } from './system.js';

describe('parseWorkerResult', () => {
  it('returns the recognized text, trimmed', () => {
    expect(parseWorkerResult('{"text":"  TypeError: boom\\n"}', 0, null)).toEqual({
      ok: true,
      text: 'TypeError: boom',
    });
  });

  it('maps an all-whitespace result to no-text', () => {
    expect(parseWorkerResult('{"text":"   \\n "}', 0, null)).toEqual({
      ok: false,
      reason: 'no-text',
    });
  });

  it('maps the worker\'s "unavailable" envelope to unavailable', () => {
    // The platform has no prebuilt binary — the child could not require the module.
    expect(parseWorkerResult('{"error":"unavailable"}', 0, null)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('maps a "No text recognized" throw to no-text, not a failure', () => {
    expect(parseWorkerResult('{"error":"No text recognized"}', 0, null)).toEqual({
      ok: false,
      reason: 'no-text',
    });
  });

  it('reports any other recognizer error with its detail', () => {
    expect(parseWorkerResult('{"error":"image decode failed"}', 0, null)).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'image decode failed',
    });
  });

  it('names the signal when the recognizer crashes', () => {
    // The whole reason recognition runs out of process: this used to kill the TUI.
    const out = parseWorkerResult('', null, 'SIGBUS');
    expect(out).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'the system text recognizer crashed (SIGBUS)',
    });
  });

  it('still reports a crash when the child died mid-write', () => {
    // Partial JSON must not be mistaken for a recognizer error message.
    const out = parseWorkerResult('{"text":"half', null, 'SIGILL');
    expect(out).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'the system text recognizer crashed (SIGILL)',
    });
  });

  it('falls back to the exit code when there is nothing else to report', () => {
    expect(parseWorkerResult('', 7, null)).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'text recognition exited with code 7',
    });
  });

  it('does not treat unparseable output as success', () => {
    const out = parseWorkerResult('not json at all', 0, null);
    expect(out.ok).toBe(false);
  });
});
