// Last-resort rumination recovery (Tier 2): when a cross-round reasoning loop has survived the
// ledger + tool-withdrawal and is about to be terminally stopped, give the model ONE biased round
// first — a mild, one-shot logit_bias that down-weights the loop's own recurring tokens, nudging it
// off the rut. This is a probabilistic last shot before the honest stop: if it fails, the loop just
// stops as it would have. The pollution risk (biasing tokens the model still needs) is bounded by
// firing only on rumination (NOT edit-recovery, where the repeated tokens are the work), keeping the
// bias mild and one-shot, exempting tool-name tokens, and capping the count. See agent/loop.ts.
//
// llama.cpp/vllm honor logit_bias; backends without a /tokenize endpoint (e.g. Ollama) yield no
// token ids, so buildRuminationLogitBias returns null and the caller stops honestly — the recovery
// is self-gating on tokenizer availability.
import { mapLimit } from '../limit.js';
import { tokenize } from '../provider/transport.js';

// Generic glue + reasoning filler: words too topic-independent to identify the loop, so biasing them
// would perturb healthy generation without targeting the spiral. Lowercase (shingles are lowercased).
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'so',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'as',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'we',
  'you',
  'they',
  'them',
  'our',
  'my',
  'your',
  'their',
  'not',
  'no',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'have',
  'has',
  'had',
  'here',
  'there',
  'what',
  'which',
  'when',
  'where',
  'how',
  'why',
  'about',
  'from',
  'into',
  'than',
  'because',
  // reasoning filler that recurs in every spiral regardless of topic
  'wait',
  'let',
  'actually',
  'hmm',
  'okay',
  'well',
  'just',
  'really',
  'maybe',
  'think',
  'need',
  'want',
]);

// Pull the most-recurrent distinctive words out of the ruminated k-grams. Frequency across the
// repeated shingles surfaces the spine of the loop; the stopword + length filters keep generic glue
// out. Pure + exported for tests.
export function selectBiasWords(
  shingles: string[],
  opts: { max: number; minLen: number },
): string[] {
  const freq = new Map<string, number>();
  for (const sh of shingles) {
    for (const raw of sh.split(' ')) {
      const w = raw.replace(/[^a-z0-9_]/g, ''); // shingles are already lowercased
      if (w.length < opts.minLen || STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // freq desc, then stable by word
    .slice(0, opts.max)
    .map(([w]) => w);
}

// Assemble the token id → bias map: drop exempt ids (tool-call name tokens), dedup, and cap the count
// so a biased round can never broadly suppress the vocabulary. Uniform mild bias. Pure + exported.
export function buildLogitBias(opts: {
  entryIds: number[];
  exempt: Set<number>;
  bias: number;
  cap: number;
}): Record<number, number> {
  const out: Record<number, number> = {};
  for (const id of opts.entryIds) {
    if (opts.exempt.has(id) || id in out) continue;
    if (Object.keys(out).length >= opts.cap) break;
    out[id] = opts.bias;
  }
  return out;
}

const BIAS_WORD_MAX = 12; // distinct ruminated words to target
const BIAS_WORD_MIN_LEN = 4; // skip short glue words
// /tokenize calls in flight at once. One recovery is up to two dozen tiny requests; a burst that
// wide is harmless on llama.cpp but is a rate-limit trip on a hosted endpoint (#338).
const TOKENIZE_CONCURRENCY = 4;
const BIAS_VALUE = -4; // mild: reshapes the distribution, never bans (a ban is -100 / false)
const BIAS_CAP = 24; // hard ceiling on the number of biased token ids

// Build the one-shot logit_bias map for a rumination loop. Returns null when there's nothing worth
// biasing or the backend can't tokenize (→ caller stops honestly instead of biasing blind).
export async function buildRuminationLogitBias(opts: {
  baseURL: string;
  apiKey: string;
  shingles: string[];
  toolNames: string[];
  signal?: AbortSignal;
  // Bias magnitude override. Defaults to BIAS_VALUE; plan mode passes a milder value because that
  // recovery round writes the deliverable (the plan), so it's more output-sensitive. See loop.ts.
  bias?: number;
}): Promise<Record<number, number> | null> {
  const words = selectBiasWords(opts.shingles, { max: BIAS_WORD_MAX, minLen: BIAS_WORD_MIN_LEN });
  if (words.length === 0) return null;

  const entryIds = await firstTokenIds(opts, words);
  if (entryIds.length === 0) return null; // no /tokenize → unsupported backend, don't bias blind

  // Exempt the tool names' entry tokens so the biased round can still NAME a tool it needs to call.
  const exempt = new Set(await firstTokenIds(opts, opts.toolNames));

  const bias = buildLogitBias({ entryIds, exempt, bias: opts.bias ?? BIAS_VALUE, cap: BIAS_CAP });
  return Object.keys(bias).length > 0 ? bias : null;
}

// First token id of each word's " word" tokenization (leading space = how it appears mid-text, so
// the first id is the token that *starts* the word). Biasing entry tokens breaks the loop's re-entry
// without suppressing the word's subword pieces, which recur in healthy text. Tokenized a few at a
// time; a word whose tokenize() returns null (endpoint absent) is dropped.
async function firstTokenIds(
  opts: { baseURL: string; apiKey: string; signal?: AbortSignal },
  words: string[],
): Promise<number[]> {
  const results = await mapLimit(words, TOKENIZE_CONCURRENCY, w =>
    tokenize({ ...opts, content: ` ${w}` }),
  );
  const ids: number[] = [];
  for (const r of results) if (r && r.length > 0) ids.push(r[0]);
  return ids;
}

// Channel guard for the bias sites. Both logit-recovery hosts justify down-weighting a loop's
// recurring tokens on one specific ground: at those sites the repeated k-grams are *filler* — the
// model re-deriving the same analysis — not the work product, so nudging off them can't damage the
// answer. That argument holds for the REASONING channel only. When ReasoningTrace has fallen back to
// the CONTENT channel (a model with no reasoning channel, see reasoningtrace.ts), the recurring
// k-grams ARE the model's emitted answer text, which is exactly the loop-tokens-≡-work-tokens trap
// that makes logit_bias dangerous. So content-channel loops get no bias: both hosts already treat a
// null bias as fail-open (the agent terminal stops as before, the plan force-write proceeds
// unbiased), so the exemption costs nothing and needs no new branch at either site.
export function biasableShingles(shingles: string[], channel: 'reasoning' | 'content'): string[] {
  return channel === 'reasoning' ? shingles : [];
}
