import { loadConfig, resolveProfile, withProbedLimits } from './config.js';
import {
  needsLimitsProbe,
  probeModelLimits,
  type ModelLimitsProbe,
} from './provider/modellimits.js';
import { bootstrap } from './context/bootstrap.js';
import {
  chatTools,
  chooseSearchBackend,
  defaultTools,
  minimalTools,
  grindTools,
  planTools,
  searchPrecedenceNotice,
} from './tools/index.js';
import { isOffline } from './tools/_net.js';
import { connectMcpServers, type McpRuntime } from './mcp/manager.js';
import { PayloadStore } from './store/payloads.js';
import { runTurn, type ShrinkCounts } from './agent/loop.js';
import { PrefixTrace } from './agent/prefixtrace.js';
import type { NativeImage } from './agent/attachments.js';
import { GenReserve, withGenReserve } from './agent/genreserve.js';
import { detectIdentity, setIdentity } from './ui/identity.js';
import { kFormat } from './ui/format.js';
import {
  buildImplementPrompt,
  isMinimalPrompt,
  isGrindPrompt,
  planWritten,
  turnPromptMode,
  turnTools,
} from './ui/commands.js';
import type { Config, ContextBundle, Message, Mode, Profile, Tool, Usage } from './types.js';

// One session: boot plus the state a turn hands the next (#403). The loop was never UI-coupled, but
// "a session" was — each consumer booted its own and threaded calibration, rates and shrink counts
// by hand, and the copies drifted (the eval runner never probed the window, so it measured a
// configuration no TUI session runs). App, headless and the eval runner all drive this; slash
// commands, the scrollback and every dialog stay with the front end that draws them.

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
    | 'onToolStart'
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

export type ToolLists = {
  agent: Tool[];
  plan: Tool[];
  chat: Tool[];
  minimal: Tool[];
  grind: Tool[];
};

export type SubmitOptions = {
  mode: Mode;
  // What the user prompt is recorded as when it differs from what it runs as: /implement typed in
  // vibe mode runs an agent turn but belongs to the vibe session. Vibe itself records as vibe.
  recordAs?: Mode;
  // What the user bubble shows when it differs from the model text (a skill body, a mention).
  display?: string;
  skill?: string;
  // Images the model is shown directly on a native-vision profile, for the first turn only: vibe's
  // implement phase gets none, since by then the image is history's note, not live bytes.
  nativeImages?: NativeImage[];
  // Overrides the mode's tool list: an eval fixture runs plan tools under the agent prompt.
  tools?: Tool[];
  // `/compact` (issue #481): a harness-driven compaction — compaction-note round + fold — with no
  // user turn and no reply. The fold joins the same session-cumulative counters the automatic
  // shrink events advance, so the two paths stay in sync regardless of which fired last.
  manualCompact?: boolean;
  signal?: AbortSignal;
  // Per-submit over the session's own, for a front end whose handlers close over render state.
  events?: SessionEvents;
  requestApproval?: RunTurnOptions['requestApproval'];
  requestQuestion?: RunTurnOptions['requestQuestion'];
  isUnattended?: RunTurnOptions['isUnattended'];
  // Brackets each loop turn the submit runs (vibe runs two), for a front end that owns per-turn
  // state. A start that returns a signal aborts that turn alone; otherwise `signal` covers all.
  onTurnStart?: () => AbortSignal | void;
  onTurnEnd?: () => void;
  // Given, a failed turn is reported here and the submit carries on as if the turn had ended —
  // which for vibe means no written plan, so no implementation. Absent, the failure throws.
  onTurnError?: (error: Error) => void;
};

// What a front end renders from: changes whenever the profile, the config or the bundle does.
export type SessionSnapshot = {
  // Unresolved: every profile, with `profile` naming the active one.
  config: Config;
  profile: string;
  bundle: ContextBundle;
};

type Side = 'agent' | 'chat';

export type Session = {
  readonly bundle: ContextBundle;
  // The active profile resolved onto the config — what a turn runs with.
  readonly config: Config;
  readonly profile: string;
  readonly offline: boolean;
  // Which search provider won when both are configured; undefined otherwise, or when offline.
  readonly searchNotice: string | undefined;
  // What the startup probe learned, worded for the user; undefined when it found nothing.
  readonly limitsNotice: string | undefined;
  // MCP servers' connections and what they offer (#265). Closed by the front end on exit; empty
  // when nothing is configured.
  readonly mcp: McpRuntime;
  // Startup lines about MCP — what connected, what failed, and any config error — for the front end
  // to print once. Not in the model's context: it describes the harness, not the task.
  readonly mcpNotices: string[];
  readonly lists: ToolLists;
  // Model-facing history of the active side: the loop appends and folds it in place, and the fold
  // must survive to the next turn (#183).
  readonly history: Message[];
  // Everything the turns emitted since the last reset, in order — what a transcript saves.
  readonly transcript: Message[];
  readonly totals: Usage;
  readonly lastUsage: Usage | undefined;
  readonly shrink: ShrinkCounts;
  readonly calibration: number | undefined;
  readonly decodeRate: number | undefined;
  // Runs one prompt as `mode` and returns the messages it emitted. Vibe is a plan turn, then the
  // implement prompt as an agent turn only when a plan was actually written.
  submit(text: string, opts: SubmitOptions): Promise<Message[]>;
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  // Switches the active profile. A profile with no window asks its endpoint (#417), not awaited by
  // the switch itself; the promise carries the notice when the probe learned something.
  setProfile(name: string): Promise<string | undefined>;
  addProfile(name: string, profile: Profile): void;
  updateBundle(update: (bundle: ContextBundle) => ContextBundle): void;
  // Chat keeps its own model history (isolated from agent/plan/shell); crossing the boundary stashes
  // the side being left and restores the other.
  switchSide(side: Side): void;
  // Replaces both sides' model history with a resumed conversation.
  loadHistory(active: Message[], other: Message[]): void;
  // Drops the conversation and everything measured about it. `relearn` also forgets what was learned
  // about the engine and returns to the default profile — /new, where the next model may differ.
  reset(opts?: { relearn?: boolean }): void;
};

export async function createSession(opts: SessionOptions): Promise<Session> {
  let cfg = opts.config ?? loadConfig();
  let profile = opts.profile ?? 'default';
  // Identity detection runs CONCURRENTLY with bootstrap, not before it. Four git subprocesses cost
  // ~28ms warm, pure added latency to first paint if serialized (measured: 29ms bootstrap + 28ms
  // detect = 56ms serial, 36ms concurrent). Both are still awaited, so the scrubber's token set is
  // loaded before any message can be rendered or saved; detection is best-effort, fail-open like
  // the other scrub layers. The window probe (#417) rides the same concurrency: a local server
  // answers in milliseconds, and it must land before anything reads the window.
  const [booted, probed, , mcp] = await Promise.all([
    bootstrap(opts.cwd, cfg.repoMapBudget),
    needsLimitsProbe(cfg.profiles[profile] ?? cfg.profiles.default)
      ? probeModelLimits(cfg.profiles[profile] ?? cfg.profiles.default)
      : Promise.resolve(undefined),
    cfg.anon
      ? detectIdentity(opts.cwd)
          .then(setIdentity)
          .catch(() => {})
      : Promise.resolve(),
    // MCP servers start here, concurrently with everything else: they are subprocesses whose
    // handshake takes as long as it takes, and the session cannot build its tool list without them.
    // A server that fails comes back as a notice, not an exception (#265).
    connectMcpServers(cfg.mcpServers ?? []),
  ]);
  let bundle = booted;
  if (probed) cfg = withProbedLimits(cfg, profile, probed);
  // Profiles whose probe reached no server (llama-server still loading): asked again at the next
  // submit on that profile, awaited so the window governs that turn rather than the one after.
  const retryWindow = new Set<string>();
  if (probed && !probed.reached) retryWindow.add(profile);

  // No route out → no web tools this session (#392). Checked once, here, because the tool list is
  // part of the cached prefix; the per-turn latch in the tools covers a drop later.
  const offline = isOffline();
  const filter = (tools: Tool[]): Tool[] =>
    opts.canAsk === false ? tools.filter(t => t.name !== 'ask_user') : tools;
  const lists: ToolLists = {
    // MCP tools ride the agent list only, by the rule that decides every other list: a mode's
    // guarantee is structural, and an MCP tool is opaque to the harness — nothing here can prove a
    // server's tool does not write files, so plan mode (which cannot mutate the repo) and chat
    // (no filesystem or shell) cannot have one. Agent mode is where an added capability belongs.
    agent: filter([...defaultTools(cfg, { offline }), ...mcp.tools]),
    plan: filter(planTools(cfg, { offline })),
    chat: filter(chatTools(cfg, { offline })),
    minimal: filter(minimalTools()),
    grind: filter(grindTools()),
  };

  const sessionEvents = opts.events ?? {};
  let side: Side = 'agent';
  let history: Message[] = [];
  let stashed: Partial<Record<Side, Message[]>> = {};
  let transcript: Message[] = [];
  const payloads = new PayloadStore();
  let prefixTrace = new PrefixTrace();
  let totals: Usage = { promptTokens: 0, completionTokens: 0 };
  let lastUsage: Usage | undefined;
  let shrink: ShrinkCounts = { sheds: 0, folds: 0 };
  let calibration: number | undefined;
  let prefillRate: number | undefined;
  let decodeRate: number | undefined;
  // Learned from what this model generates (#551), so it goes wherever the decode rate goes.
  let genReserve = new GenReserve();

  const listeners = new Set<() => void>();
  let snapshot: SessionSnapshot = { config: cfg, profile, bundle };
  const changed = (): void => {
    snapshot = { config: cfg, profile, bundle };
    for (const l of listeners) l();
  };

  const retryWindowProbe = async (): Promise<Message | undefined> => {
    const current = cfg.profiles[profile];
    if (!current || !retryWindow.has(profile) || current.contextWindow != null) return undefined;
    const probe = await probeModelLimits(current);
    if (probe.reached) retryWindow.delete(profile);
    const notice = probedLimitsNotice(probe);
    if (!notice) return undefined;
    cfg = withProbedLimits(cfg, profile, probe);
    changed();
    return { role: 'system', content: notice };
  };

  const runOne = async (
    text: string,
    active: Mode,
    recorded: Mode,
    submit: SubmitOptions,
  ): Promise<Message[]> => {
    const events = { ...sessionEvents, ...submit.events };
    const emitted: Message[] = [];
    const emit = (msg: Message): void => {
      transcript.push(msg);
      emitted.push(msg);
      events.onMessage?.(msg);
    };
    const signal = submit.onTurnStart?.() ?? submit.signal;
    // Staged like App's pendingNotices: a receipt follows whatever opens the turn and never
    // precedes it — the user echo normally, but a manual compaction (#481) has none. Hoisted out of
    // try so the tail flush below can't drop it on a turn that emits no message at all.
    const pending: Message[] = [];
    try {
      const retried = await retryWindowProbe();
      if (retried) pending.push(retried);
      await runTurn({
        ...events,
        userInput: text,
        userDisplay: submit.display,
        userSkill: submit.skill,
        nativeImages: submit.nativeImages,
        history,
        bundle,
        config: resolveProfile(cfg, profile),
        tools: submit.tools ?? turnTools(active, lists),
        payloads,
        signal: signal ?? undefined,
        requestApproval: submit.requestApproval ?? opts.requestApproval,
        requestQuestion: submit.requestQuestion ?? opts.requestQuestion,
        isUnattended: submit.isUnattended,
        promptMode: turnPromptMode(active),
        minimalPrompt: isMinimalPrompt(active),
        grindPrompt: isGrindPrompt(active),
        manualCompact: submit.manualCompact,
        // The prompt carries the turn's mode from here on (the loop has no notion of one), so a
        // saved transcript can say what each turn was.
        onMessage: raw => {
          const msg: Message = raw.role === 'user' ? { ...raw, mode: recorded } : raw;
          emit(msg);
          for (const n of pending.splice(0)) emit(n);
        },
        onUsage: u => {
          lastUsage = u;
          totals = {
            promptTokens: totals.promptTokens + u.promptTokens,
            completionTokens: totals.completionTokens + u.completionTokens,
            ...(u.cachedTokens != null || totals.cachedTokens != null
              ? { cachedTokens: (totals.cachedTokens ?? 0) + (u.cachedTokens ?? 0) }
              : {}),
          };
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
        genReserve,
      });
    } catch (e) {
      if (!submit.onTurnError) throw e;
      submit.onTurnError(e as Error);
    } finally {
      for (const n of pending.splice(0)) emit(n);
      submit.onTurnEnd?.();
    }
    return emitted;
  };

  const submit = async (text: string, submitOpts: SubmitOptions): Promise<Message[]> => {
    if (submitOpts.mode !== 'vibe') {
      return runOne(text, submitOpts.mode, submitOpts.recordAs ?? submitOpts.mode, submitOpts);
    }
    const planned = await runOne(text, 'plan', 'vibe', submitOpts);
    // No planFinal marker means the plan phase was aborted or dead-ended — never chain edits off a
    // turn that didn't actually commit a plan.
    if (!planWritten(planned)) {
      const skipped: Message = {
        role: 'system',
        content: 'vibe: the plan phase ended without a written plan — skipping implementation.',
      };
      transcript.push(skipped);
      planned.push(skipped);
      ({ ...sessionEvents, ...submitOpts.events }).onMessage?.(skipped);
      return planned;
    }
    // No history threading needed: the plan phase appended straight into the shared model history,
    // so the implement phase picks it up from there.
    const implemented = await runOne(buildImplementPrompt(''), 'agent', 'vibe', {
      ...submitOpts,
      mode: 'agent',
      display: '/implement (vibe)',
      skill: undefined,
      nativeImages: undefined,
    });
    return [...planned, ...implemented];
  };

  const setProfile = (name: string): Promise<string | undefined> => {
    const next = cfg.profiles[name];
    if (!next) return Promise.resolve(undefined);
    profile = name;
    // The tok/s chip describes the model that produced it (#204) — left standing, the previous
    // model's rate reads as the new one's until a round here measures one.
    decodeRate = undefined;
    genReserve = new GenReserve();
    changed();
    if (!needsLimitsProbe(next)) return Promise.resolve(undefined);
    return probeModelLimits(next).then(probe => {
      if (!probe.reached) retryWindow.add(name);
      const notice = probedLimitsNotice(probe);
      if (!notice) return undefined;
      cfg = withProbedLimits(cfg, name, probe);
      changed();
      return notice;
    });
  };

  const reset = (resetOpts: { relearn?: boolean } = {}): void => {
    history = [];
    stashed = {};
    transcript = [];
    // With the history and stashes gone, no payloadId can reach the store anymore.
    payloads.clear();
    totals = { promptTokens: 0, completionTokens: 0 };
    lastUsage = undefined;
    shrink = { sheds: 0, folds: 0 };
    // The engine holds none of the dropped bytes, so the trace compares against nothing.
    prefixTrace = new PrefixTrace();
    if (!resetOpts.relearn) return;
    calibration = undefined;
    // The default profile may be a different model on different hardware — a rate learned under
    // the old one would misprice every round until it re-learns.
    prefillRate = undefined;
    decodeRate = undefined;
    genReserve = new GenReserve();
    if (profile !== 'default') {
      profile = 'default';
      changed();
    }
  };

  return {
    get bundle() {
      return bundle;
    },
    // With the learned reserve applied, so the KV warm and the gauge budget with the number the
    // next round will (#551).
    get config() {
      return withGenReserve(resolveProfile(cfg, profile), genReserve);
    },
    get profile() {
      return profile;
    },
    offline,
    searchNotice: offline ? undefined : searchPrecedenceNotice(chooseSearchBackend(cfg)),
    limitsNotice: probed && probedLimitsNotice(probed),
    mcp,
    // Config errors come first: they explain a server that never even started.
    mcpNotices: [...(cfg.mcpErrors ?? []), ...mcp.notices],
    lists,
    get history() {
      return history;
    },
    get transcript() {
      return transcript;
    },
    get totals() {
      return totals;
    },
    get lastUsage() {
      return lastUsage;
    },
    get shrink() {
      return shrink;
    },
    get calibration() {
      return calibration;
    },
    get decodeRate() {
      return decodeRate;
    },
    submit,
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setProfile,
    addProfile: (name, next) => {
      cfg = { ...cfg, profiles: { ...cfg.profiles, [name]: next } };
      changed();
    },
    updateBundle: update => {
      const next = update(bundle);
      if (next === bundle) return;
      bundle = next;
      changed();
    },
    switchSide: next => {
      if (next === side) return;
      stashed[side] = history;
      history = stashed[next] ?? [];
      delete stashed[next];
      side = next;
    },
    loadHistory: (active, other) => {
      history = active;
      stashed = { [side === 'chat' ? 'agent' : 'chat']: other };
    },
    reset,
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
