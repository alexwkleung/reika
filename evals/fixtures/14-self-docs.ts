import type { Fixture } from '../types.js';
import { DOCS_DIR } from '../../src/version.js';

// Does a model asked about reika itself read reika's shipped docs rather than answer from its
// priors (#531)? Uptake, so it needs a model, and 3+ runs per arm (`REIKA_SELF_AWARE=0` is the
// baseline, where the prompt names no docs path).
//
// The flag asked about was picked because nothing about its name gives the answer away: a default
// of 0.7 clamped to 0.3–0.95 is not something a model reconstructs from "AGE_LOW_FRACTION", so a
// correct answer without a read of the docs is either luck or a model that has seen this repo.
// Graded on the route as well as the answer: the fixture repo holds nothing about reika, so a
// correct answer reached any other way is reported as such rather than passed.
export const fixture: Fixture = {
  name: 'self-docs',
  setup: {
    'README.md': '# scratch project\n\nA placeholder repo.\n',
  },
  prompt:
    'What does the reika setting REIKA_AGE_LOW_FRACTION do, and what are its default and allowed range?',
  // 15 min: qwen3.8-27b-xhigh timed out twice at 8 after 3–4 calls — slow reasoning, not a stall.
  timeoutMs: 15 * 60 * 1000,
  assert: ({ messages }) => {
    if (!DOCS_DIR) return { pass: false, reason: 'no docs/ in this install — nothing to find' };
    const calls = messages.flatMap(m => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
    const touchedDocs = calls.some(c =>
      Object.values(c.args).some(v => typeof v === 'string' && v.includes(DOCS_DIR!)),
    );
    const answer = messages
      .flatMap(m => (m.role === 'assistant' && m.content ? [m.content] : []))
      .join('\n');
    const correct = /\b0?\.7\b/.test(answer) && /0?\.3\b/.test(answer) && /0?\.95\b/.test(answer);

    if (touchedDocs && correct) return { pass: true, note: `${calls.length} tool calls` };
    if (touchedDocs) {
      return { pass: false, reason: 'read the docs but the answer misses the default or range' };
    }
    if (correct) {
      return { pass: false, reason: 'answered correctly without reading the docs (from priors)' };
    }
    return {
      pass: false,
      reason: `never looked in the docs; tool calls: ${calls.map(c => c.name).join(', ') || '(none)'}`,
    };
  },
};
