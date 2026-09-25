import type { QuestionOption, Tool, ToolResult } from '../types.js';

// A menu, not a conversation. Two is the floor because a one-option "question" is a statement the
// model should just act on; four is the ceiling because a fifth row is almost always padding — and a
// padded option from a low-quant model is not harmless filler, it is a plausible-sounding choice that
// falls apart on inspection. Forcing a fixed count is worse than allowing a range: most real
// questions here are binaries (flag it or don't, extend the list or invert the polarity), and a
// genuine binary rendered as two rows beats the same binary padded to three.
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

// Keys a model plausibly uses for each field. Accepting its dialect costs a few lines here and saves
// a rejected call — and a rejected call sends the model back to guessing, which is the failure this
// tool exists to prevent. Same reasoning as the read/grep argument aliases (#102).
const LABEL_KEYS = ['label', 'text', 'title', 'name', 'option', 'value', 'answer'];
const DESCRIPTION_KEYS = ['description', 'detail', 'details', 'explanation', 'preview', 'note'];
const RECOMMENDED_KEYS = ['recommended', 'recommend', 'isRecommended', 'is_recommended', 'default'];

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function isTruthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

// Strips list scaffolding a model adds when it writes options as prose ("1. ", "- ", "* ", "a) ").
// Without this the labels render as "1. Flag it" inside a list that already numbers itself.
function stripBullet(s: string): string {
  return s.replace(/^\s*(?:[-*•]|\(?[0-9a-zA-Z][).])\s+/, '').trim();
}

export function normalizeOptions(raw: unknown): QuestionOption[] {
  // A single newline-separated string is a common shape from models that treat every argument as
  // text. Split it rather than failing the call over formatting.
  const entries: unknown[] =
    typeof raw === 'string'
      ? raw
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
      : Array.isArray(raw)
        ? raw
        : [];

  const out: QuestionOption[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let label: string | undefined;
    let description: string | undefined;
    let recommended = false;
    if (typeof entry === 'string') {
      label = stripBullet(entry);
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const raw = firstString(obj, LABEL_KEYS);
      label = raw ? stripBullet(raw) : undefined;
      description = firstString(obj, DESCRIPTION_KEYS);
      recommended = RECOMMENDED_KEYS.some(k => isTruthy(obj[k]));
    }
    if (!label) continue;
    // Two rows that say the same thing is a menu that can't be answered. Weak models repeat
    // themselves under pressure, and this is exactly where they're under pressure.
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      ...(description ? { description } : {}),
      ...(recommended ? { recommended: true } : {}),
    });
    if (out.length === MAX_OPTIONS) break;
  }

  // At most one recommendation: a model marking every row has expressed nothing, and the UI would
  // render a marker that carries no information.
  let marked = false;
  for (const o of out) {
    if (!o.recommended) continue;
    if (marked) delete o.recommended;
    marked = true;
  }
  return out;
}

// Returned instead of thrown. A thrown tool error reads to the model as "the harness broke"; a
// result that names the exact shape it should have sent is something it can act on next round.
function malformed(detail: string): ToolResult {
  return {
    summary: `ask_user: ${detail}`,
    payload:
      `Your ask_user call was not shown to the user: ${detail}\n\n` +
      `Send it again in this shape:\n` +
      `  question: one sentence naming the single thing you need decided\n` +
      `  options: a list of ${MIN_OPTIONS}-${MAX_OPTIONS} entries, each { "label": "<a full sentence stating one choice>" }\n\n` +
      `Or, if you can settle this yourself from the code, drop the question and continue the work.`,
  };
}

export const askUserTool: Tool = {
  name: 'ask_user',
  // The trigger lives here rather than in the system prompt because this is the text a model
  // consults when deciding whether to reach for a tool. Stated as a precondition ("you have already
  // read...") on purpose: a gate phrased as "when unclear" fires constantly on a low-quant model,
  // since everything is unclear to it.
  description:
    'Ask the user ONE multiple-choice question and wait for their answer. Use only after you have ' +
    'read the relevant code and it contradicts the request, or two readings of the request would ' +
    'produce different code. Never use it for anything a tool could answer. Once per turn.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'One sentence naming the single thing you need decided.',
      },
      options: {
        type: 'array',
        description: `${MIN_OPTIONS}-${MAX_OPTIONS} choices. Do not pad to reach a count.`,
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description:
                'A full sentence stating one choice. Do not abbreviate it to a few words.',
            },
            description: {
              type: 'string',
              description: 'Optional: what picking this would mean. Omit if the label says it.',
            },
            recommended: {
              type: 'boolean',
              description: 'Optional: set on at most one option, the one you lean toward.',
            },
          },
          required: ['label'],
        },
      },
    },
    required: ['question', 'options'],
  },

  async run(args, ctx): Promise<ToolResult> {
    const question =
      typeof args.question === 'string' && args.question.trim()
        ? args.question.trim()
        : typeof args.prompt === 'string' && args.prompt.trim()
          ? args.prompt.trim()
          : '';
    if (!question) return malformed('no question text was given');

    const options = normalizeOptions(args.options);
    if (options.length < MIN_OPTIONS) {
      return malformed(
        `only ${options.length} usable option${options.length === 1 ? '' : 's'} came through — at least ${MIN_OPTIONS} are needed`,
      );
    }

    // The cap. Answering a second question is almost never what unblocks a turn, and a tool that can
    // be called repeatedly gives a model stuck on a decision a fresh way to keep not deciding.
    const asked = ctx.askedQuestions;
    if (asked && asked.length > 0) {
      return {
        summary: 'ask_user: already asked this turn',
        payload:
          `You have already asked the user a question this turn:\n  "${asked[0]}"\n\n` +
          'Only one question per turn is allowed. Proceed with the work using the answer you were ' +
          'given, and settle anything still open from the code itself.',
      };
    }

    // No one to ask (subagent, test, non-interactive, or a session switched unattended mid-way #526).
    // Degrade to a directive rather than hanging on a prompt that will never be answered.
    if (!ctx.requestQuestion || ctx.unattended) {
      return {
        summary: 'ask_user: no user available to answer',
        payload:
          'There is no interactive user to answer questions in this context. Decide from the code ' +
          'yourself, pick the reading you can best support, and say plainly in your final message ' +
          'which way you went and why.',
      };
    }

    const answer = await ctx.requestQuestion({ question, options });
    asked?.push(question);

    if (!answer) {
      return {
        summary: 'ask_user: dismissed',
        payload:
          'The user dismissed the question without answering. Continue with your own best reading, ' +
          'and say in your final message which way you went.',
      };
    }

    const parts = [`You asked: ${question}`, `The user answered: ${answer.text}`];
    if (answer.notes) parts.push(`The user added: ${answer.notes}`);
    // Settles the one point asked, not the turn — see buildQuestionLedger for why "act on it now"
    // was the wrong verb.
    parts.push(
      'This is settled. Continue what you were doing on that basis — do not re-derive it, re-read ' +
        'the code to second-guess it, or ask again.',
    );
    const shown = answer.notes ? `${answer.text} (+ note)` : answer.text;
    return {
      summary: `Asked the user — answered: ${shown}`,
      payload: parts.join('\n'),
    };
  },
};
