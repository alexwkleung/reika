// Deterministic routing from a plain-English prompt to a skill. The model is never asked which
// skill applies: selection is scored here, in the harness, before the request prefix is built.
//
// Two reasons it works this way rather than as a model-callable tool. A wrong pick at 30B/Q2 dumps
// a multi-KB skill body into a window that may only be 16k — much more expensive than the wasted
// tokens the same mistake costs a frontier model. And a skill invoked mid-loop rewrites the prompt
// prefix at round N, which invalidates the engine's prefix cache (all-or-nothing on SWA models) —
// the exact cost REIKA_PREFIX_STABLE and REIKA_WARM exist to avoid. Selecting at submit time keeps
// the injection in round 0, where it's just part of the user message.
import type { Skill } from './skills.js';

export type SkillMatch = {
  skill: Skill;
  score: number;
  // Which trigger phrases fired — shown in the receipt so a surprising match is explainable.
  matched: string[];
};

// A suggestion is a one-line hint on a turn that runs normally either way, so one trigger is
// enough to earn it. Auto-injection rewrites what the model is asked to do, so it wants
// corroboration — two triggers, or one multi-word phrase.
const SUGGEST_MIN_SCORE = 1;
const AUTO_MIN_SCORE = 2;

// Fraction of the context window a skill body may occupy before auto-injection is refused. A body
// past this leaves too little room for the actual work; the suggestion still shows, so the user
// can run it deliberately (and spend the window knowingly).
const AUTO_BODY_WINDOW_FRACTION = 0.15;
// Pessimistic chars-per-token, same reasoning as CAP_DENSITY_FLOOR in toolcall.ts — a skill body
// full of code/paths tokenizes far denser than char/4, and over-estimating room here is what
// would push the round-0 request past the window.
const DENSE_CHARS_PER_TOKEN = 2.5;
const AUTO_BODY_CHARS_FALLBACK = 6000;

// Prompts that only carry over the previous turn's intent. Routing these would fire a skill on
// "yes" — the user is answering, not asking for a workflow.
const CONTINUATIONS = new Set([
  'y',
  'n',
  'yes',
  'yeah',
  'yep',
  'no',
  'ok',
  'okay',
  'sure',
  'go',
  'go ahead',
  'go on',
  'continue',
  'keep going',
  'proceed',
  'do it',
  'next',
  'again',
  'retry',
  'fix it',
  'thanks',
]);

// Score every skill against the prompt and return the single best, or null when nothing clears the
// bar or two skills tie (an ambiguous match is worse than none — it would route by array order).
export function matchSkill(prompt: string, skills: Skill[]): SkillMatch | null {
  const haystack = normalize(prompt);
  if (!haystack || CONTINUATIONS.has(haystack.trim())) return null;

  const ranked: SkillMatch[] = [];
  for (const skill of skills) {
    const matched = candidatePhrases(skill).filter(p => haystack.includes(` ${p} `));
    if (matched.length === 0) continue;
    // Word count, not phrase count: "run the app" is far stronger evidence than "run", and
    // summing words is what lets one specific phrase clear the auto bar on its own.
    const score = matched.reduce((sum, p) => sum + p.split(' ').length, 0);
    ranked.push({ skill, score, matched });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length > 1 && ranked[1].score === ranked[0].score) return null;
  return ranked[0].score >= SUGGEST_MIN_SCORE ? ranked[0] : null;
}

// Whether a match is strong enough to rewrite the prompt rather than just mention the skill.
export function shouldAutoInject(match: SkillMatch, contextWindowTokens?: number): boolean {
  if (match.score < AUTO_MIN_SCORE) return false;
  const maxChars = contextWindowTokens
    ? contextWindowTokens * DENSE_CHARS_PER_TOKEN * AUTO_BODY_WINDOW_FRACTION
    : AUTO_BODY_CHARS_FALLBACK;
  return match.skill.body.length <= maxChars;
}

// The skill's own name is an implicit trigger — a skill called `verify` should route "verify my
// changes" without the author writing that down. Separators become spaces so `smoke-test` matches
// the way it's spoken.
function candidatePhrases(skill: Skill): string[] {
  const fromName = skill.name.replace(/[-_]+/g, ' ');
  const phrases = [fromName, ...skill.triggers]
    .map(p => normalize(p).trim())
    .filter(p => p.length >= 3);
  return [...new Set(phrases)];
}

// Space-padded so `includes(' verify ')` is a whole-word test — otherwise a skill named `test`
// matches "latest". Punctuation collapses to spaces so "verify, then commit" still matches.
function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}
