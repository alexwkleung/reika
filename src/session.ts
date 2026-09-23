import { loadConfig, resolveProfile, withProbedLimits } from './config.js';
import {
  needsLimitsProbe,
  probeModelLimits,
  type ModelLimitsProbe,
} from './provider/modellimits.js';
import { bootstrap } from './context/bootstrap.js';
import { chatTools, defaultTools, minimalTools, planTools } from './tools/index.js';
import { isOffline } from './tools/_net.js';
import { PayloadStore } from './store/payloads.js';
import { runTurn, type ShrinkCounts } from './agent/loop.js';
import { PrefixTrace } from './agent/prefixtrace.js';
import { detectIdentity, setIdentity } from './ui/identity.js';
import { kFormat } from './ui/format.js';
import {
  buildImplementPrompt,
  isMinimalPrompt,
  planWritten,
  turnPromptMode,
  turnTools,
} from './ui/commands.js';
import type { Config, ContextBundle, Message, Mode, Tool, Usage } from './types.js';

// One session: boot plus the state a turn hands the next (#403). The loop was never UI-coupled, but
// "a session" was — each consumer booted its own and threaded calibration, rates and shrink counts
// by hand, and the copies drifted (the eval runner never probed the window, so it measured a
// configuration no TUI session runs). Headless and the eval runner drive this; App is the next
// consumer, and slash commands stay in the TUI.

type RunTurnOptions = Parameters<typeof runTurn>[0];

// The loop's live callbacks, passed through as-is. The ones that feed threaded state (usage, shrink,
// calibration, rates) are wrapped so the session records them first and the consumer still hears.
export type SessionEvents = Partial<
  Pick<
    RunTurnOptions,
    | 'onMessage'
    | 'onContentDelta'
    | 'onReasoningDelta'
    | 'onPhase'
    | 'onSubagent'
    | 'onCompactionNote'
    | 'onTypecheck'
    | 'onRecovering'
    | 'onReasoningStatus'
    | 'onReasoningReset'
    | 'onUsage'
    | 'onContextEstimate'
    | 'onShrink'
    | 'onCalibration'
    | 'onPrefillRate'
    | 'onDecodeRate'
    | 'onToolProgress'
    | 'onPlanProgress'
  >
>;

export type SessionOptions = {
  cwd: string;
  // Defaults to loadConfig(), the environment the TUI reads.
  config?: Config;
  profile?: string;
  // False when nobody can answer: a model that sees ask_user calls it and stalls, so it is not
  // offered at all, and the loop reads canAsk from the tool list so the prompt agrees.
  canAsk?: boolean;
  requestApproval?: RunTurnOptions['requestApproval'];
  requestQuestion?: RunTurnOptions['requestQuestion'];
  events?: SessionEvents;
};

export type ToolLists = { agent: Tool[]; plan: Tool[]; chat: Tool[]; minimal: Tool[] };

export type SubmitOptions = {
  mode: Mode;
  // What the user bubble shows when it differs from the model text (a skill body, a mention).
  display?: string;
  skill?: string;
  // Overrides the mode's tool list: an eval fixture runs plan tools under the agent prompt.
  tools?: Tool[];
  signal?: AbortSignal;
};

export type Session = {
  readonly bundle: ContextBundle;
  // The active profile resolved onto the config — what a turn runs with.
  readonly config: Config;
  readonly offline: boolean;
  // What the startup probe learned, worded for the user; undefined when it found nothing.
  readonly limitsNotice: string | undefined;
  readonly lists: ToolLists;
  // Model-facing history: the loop appends and folds it in place, and the fold must survive.
  readonly history: Message[];
  // Everything the turns emitted, in order — what a transcript saves.
  readonly transcript: Message[];
  readonly totals: Usage;
  readonly lastUsage: Usage | undefined;
  readonly shrink: ShrinkCounts;
  // Runs one prompt as `mode` and returns the messages it emitted. Vibe is a plan turn, then the
  // implement prompt as an agent turn only when a plan was actually written.
  submit(text: string, opts: SubmitOptions): Promise<Message[]>;
};

export async function createSession(opts: SessionOptions): Promise<Session> {
  let cfg = opts.config ?? loadConfig();
  const profile = opts.profile ?? 'default';
  // Concurrent for the same reason App boots this way: identity detection and the window probe
  // are each tens of ms, pure added latency when serialized.
  const [bundle, probed] = await Promise.all([
    bootstrap(opts.cwd, cfg.repoMapBudget),
    needsLimitsProbe(cfg.profiles[profile] ?? cfg.profiles.default)
      ? probeModelLimits(cfg.profiles[profile] ?? cfg.profiles.default)
      : Promise.resolve(undefined),
    cfg.anon
      ? detectIdentity(opts.cwd)
          .then(setIdentity)
          .catch(() => {})
      : Promise.resolve(),
  ]);
  if (probed) cfg = withProbedLimits(cfg, profile, probed);
  // A probe that reached nothing (llama-server still loading) is asked again at the next submit.
  let retryWindow = probed != null && !probed.reached;

  const offline = isOffline();
  const filter = (tools: Tool[]): Tool[] =>
    opts.canAsk === false ? tools.filter(t => t.name !== 'ask_user') : tools;
  const lists: ToolLists = {
    agent: filter(defaultTools(cfg, { offline })),
    plan: filter(planTools()),
    chat: filter(chatTools(cfg, { offline })),
    minimal: filter(minimalTools()),
  };

  const events = opts.events ?? {};
  const history: Message[] = [];
  const transcript: Message[] = [];
  const payloads = new PayloadStore();
  const prefixTrace = new PrefixTrace();
  const totals: Usage = { promptTokens: 0, completionTokens: 0 };
  let lastUsage: Usage | undefined;
  let shrink: ShrinkCounts = { sheds: 0, folds: 0 };
  let calibration: number | undefined;
  let prefillRate: number | undefined;
  let decodeRate: number | undefined;

  const emit = (msg: Message, into: Message[]): void => {
    transcript.push(msg);
    into.push(msg);
    events.onMessage?.(msg);
  };

  const retryWindowProbe = async (): Promise<Message | undefined> => {
    const current = cfg.profiles[profile];
    if (!retryWindow || current?.contextWindow != null) return undefined;
    const probe = await probeModelLimits(current ?? cfg.profiles.default);
    if (probe.reached) retryWindow = false;
    const notice = probedLimitsNotice(probe);
    if (!notice) return undefined;
    cfg = withProbedLimits(cfg, profile, probe);
    return { role: 'system', content: notice };
  };

  const runOne = async (
    text: string,
    active: Mode,
    recorded: Mode,
    submit: SubmitOptions,
  ): Promise<Message[]> => {
    const emitted: Message[] = [];
    // Staged like App's pendingNotices: a receipt follows the user echo, never precedes it.
    const pending: Message[] = [];
    const retried = await retryWindowProbe();
    if (retried) pending.push(retried);
    await runTurn({
      ...events,
      userInput: text,
      userDisplay: submit.display,
      userSkill: submit.skill,
      history,
      bundle,
      config: resolveProfile(cfg, profile),
      tools: submit.tools ?? turnTools(active, lists),
      payloads,
      signal: submit.signal,
      requestApproval: opts.requestApproval,
      requestQuestion: opts.requestQuestion,
      promptMode: turnPromptMode(active),
      minimalPrompt: isMinimalPrompt(active),
      // The prompt carries the turn's mode from here on (the loop has no notion of one), so a saved
      // transcript can say what each turn was.
      onMessage: raw => {
        const msg: Message = raw.role === 'user' ? { ...raw, mode: recorded } : raw;
        emit(msg, emitted);
        if (msg.role === 'user') for (const n of pending.splice(0)) emit(n, emitted);
      },
      onUsage: u => {
        lastUsage = u;
        totals.promptTokens += u.promptTokens;
        totals.completionTokens += u.completionTokens;
        if (u.cachedTokens != null)
          totals.cachedTokens = (totals.cachedTokens ?? 0) + u.cachedTokens;
        events.onUsage?.(u);
      },
      priorShrink: shrink,
      onShrink: (event, counts) => {
        shrink = counts;
        events.onShrink?.(event, counts);
      },
      priorCalibration: calibration,
      onCalibration: f => {
        calibration = f;
        events.onCalibration?.(f);
      },
      priorPrefillRate: prefillRate,
      onPrefillRate: r => {
        prefillRate = r;
        events.onPrefillRate?.(r);
      },
      priorDecodeRate: decodeRate,
      onDecodeRate: r => {
        decodeRate = r;
        events.onDecodeRate?.(r);
      },
      prefixTrace,
    });
    return emitted;
  };

  const submit = async (text: string, submitOpts: SubmitOptions): Promise<Message[]> => {
    if (submitOpts.mode !== 'vibe')
      return runOne(text, submitOpts.mode, submitOpts.mode, submitOpts);
    const planned = await runOne(text, 'plan', 'vibe', submitOpts);
    // No planFinal marker means the plan phase was aborted or dead-ended — never chain edits off a
    // turn that didn't actually commit a plan.
    if (!planWritten(planned)) {
      emit(
        {
          role: 'system',
          content: 'vibe: the plan phase ended without a written plan — skipping implementation.',
        },
        planned,
      );
      return planned;
    }
    const implemented = await runOne(buildImplementPrompt(''), 'agent', 'vibe', {
      mode: 'agent',
      display: '/implement (vibe)',
      signal: submitOpts.signal,
    });
    return [...planned, ...implemented];
  };

  return {
    bundle,
    get config() {
      return resolveProfile(cfg, profile);
    },
    offline,
    limitsNotice: probed && probedLimitsNotice(probed),
    lists,
    history,
    transcript,
    totals,
    get lastUsage() {
      return lastUsage;
    },
    get shrink() {
      return shrink;
    },
    submit,
  };
}

// A window the harness took off the endpoint changes what the session does (compaction, the
// payload cap), so the user is told where the number came from — a gauge denominator alone
// reads as configured. Undefined when the probe found nothing worth saying.
export function probedLimitsNotice(probe: ModelLimitsProbe): string | undefined {
  const parts: string[] = [];
  if (probe.window) {
    const from = probe.windowSource === 'catalog' ? 'the models.dev catalog' : 'the endpoint';
    parts.push(
      `Context window of ${kFormat(probe.window)} tokens, from ${from} (REIKA_CONTEXT_WINDOW overrides).`,
    );
  }
  if (probe.maxOutput) {
    parts.push(
      `Output capped at ${kFormat(probe.maxOutput)} tokens per reply, from the models.dev catalog.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
