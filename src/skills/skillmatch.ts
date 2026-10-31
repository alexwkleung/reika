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
  // A matched phrase opens the prompt (after a courtesy lead like "please" / "can you"). The
  // imperative position is what separates "review pr 420" from "the pr review flow is broken".
  leading: boolean;
  // Words in the prompt. A command is short; a description of something that merely mentions the
  // skill's nouns runs long.
  words: number;
};

// A suggestion is a one-line hint on a turn that runs normally either way, so one trigger is
// enough to earn it. Auto-injection rewrites what the model is asked to do, so it wants
// corroboration — two distinct triggers, or one multi-word phrase — AND the shape of a command.
// Keyword count alone cannot tell "work on issue 412" from "the issue number is shown twice":
// measured on the shipped skills, 5 of 5 prompts that only mentioned the same nouns mid-sentence
// cleared the score bar, each prepending a body whose first line is "run `gh pr view`". What
// separates them is position and length, so the auto gate asks for both: a matched phrase opening
// the prompt, and a prompt no longer than a command with its arguments. A false negative here
// still gets the suggestion line; a false positive costs the turn.
const SUGGEST_MIN_SCORE = 1;
const AUTO_MIN_SCORE = 2;
const AUTO_MAX_WORDS = 12;
// Stripped, repeatedly, before the leading-position test — "ok please review pr 420" opens with the phrase.
const COURTESY_LEADS = [
  'can you please',
  'could you please',
  'can you',
  'could you',
  'would you',
  'please',
  'pls',
  'now',
  'next',
  'okay',
  'ok',
  'hey',
  'let s',
  'lets',
];

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

  const lead = stripCourtesyLead(haystack);
  const words = haystack.trim().split(' ').length;
  const ranked: SkillMatch[] = [];
  for (const skill of skills) {
    const hits = candidatePhrases(skill).filter(p => haystack.includes(` ${p} `));
    if (hits.length === 0) continue;
    // A phrase inside another matched phrase is the same evidence counted twice: the implicit
    // name `issue` rides along with every trigger that contains it ("issue number", "gh issue"),
    // which alone scored any such two-word phrase past the auto bar. Keep the longest.
    const matched = hits.filter(p => !hits.some(q => q !== p && ` ${q} `.includes(` ${p} `)));
    // Word count, not phrase count: "run the app" is far stronger evidence than "run", and
    // summing words is what lets one specific phrase clear the auto bar on its own.
    const score = matched.reduce((sum, p) => sum + p.split(' ').length, 0);
    const leading = matched.some(p => lead.startsWith(` ${p} `));
    ranked.push({ skill, score, matched, leading, words });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length > 1 && ranked[1].score === ranked[0].score) return null;
  return ranked[0].score >= SUGGEST_MIN_SCORE ? ranked[0] : null;
}

// Whether a match is strong enough to rewrite the prompt rather than just mention the skill,
// with nobody to ask (headless). The word cap is what prices a silent wrong pick.
export function shouldAutoInject(match: SkillMatch, contextWindowTokens?: number): boolean {
  return shouldConfirmInject(match, contextWindowTokens) && match.words <= AUTO_MAX_WORDS;
}

// Whether a match is strong enough to ASK about (#425): the auto gate minus the word cap. With a
// human confirming, the long-tail command — `review pr 420 but first explain how…` — can be
// offered instead of only suggested. `leading` stays: without it "add a pull request template"
// would prompt every time, which is the nag.
export function shouldConfirmInject(match: SkillMatch, contextWindowTokens?: number): boolean {
  if (match.score < AUTO_MIN_SCORE) return false;
  if (!match.leading) return false;
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

function stripCourtesyLead(haystack: string): string {
  let rest = haystack;
  for (let stripped = true; stripped;) {
    stripped = false;
    for (const lead of COURTESY_LEADS) {
      if (rest.startsWith(` ${lead} `)) {
        rest = ` ${rest.slice(lead.length + 2)}`;
        stripped = true;
      }
    }
  }
  return rest;
}

// Space-padded so `includes(' verify ')` is a whole-word test — otherwise a skill named `test`
// matches "latest". Punctuation collapses to spaces so "verify, then commit" still matches.
function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}
