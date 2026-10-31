import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, resolveDefaultMode } from '../config.js';
import { startProfiles } from '../laststate.js';
import {
  buildTranscriptMeta,
  saveTranscript,
  type TranscriptMeta,
  type TranscriptShrinkEvent,
  type TranscriptStatus,
} from '../store/transcript.js';
import {
  countRealTurns,
  newSessionPath,
  projectHistoryDir,
  writeSession,
  type SessionSides,
} from '../store/sessions.js';
import { createSession, type SessionEvents } from '../session.js';
import { expandMentions } from '../agent/mentions.js';
import { expandPastedUrls, planPastedUrls } from '../agent/pastedurls.js';
import { matchSkill, shouldAutoInject, shouldConfirmInject } from '../skills/skillmatch.js';
import { imageReader } from '../ocr/select.js';
import { autoApproves } from '../approval.js';
import { toolLabel } from '../ui/format.js';
import { debugLog, processSessionStem } from '../debug.js';
import { callMcpTool, findMcpCommand, parseMcpArgs } from '../mcp/tools.js';
import {
  askApproval,
  askConfirm,
  askQuestion,
  openTerminalPrompter,
  type HeadlessPrompter,
} from './headlessprompt.js';
import { pastedUrlConfirmSpec, skillConfirmSpec, type ConfirmSpec } from '../ui/dialogspecs.js';
import type { HeadlessArgs, HeadlessMode } from './headlessargs.js';

import type {
  ApprovalAnswer,
  ApprovalRequest,
  Config,
  ContextBundle,
  Message,
  Usage,
} from '../types.js';

// Headless mode (#52): `reika -p "<prompt>"` runs one turn with no TUI and prints the reply.
// The session (boot, threaded state, the vibe chain) is session.ts, shared with the eval runner;
// what lives here is the part of App's submit path that shapes what the model sees (mention/URL
// expansion, skill routing) and the approval policy. Those are deliberately the same modules App
// calls, in the same order: a headless run must be the run the TUI would have made, or it is
// useless as the debugging instrument the issue asks for.

// The TUI's mid-turn auto-save cadence.
const AUTOSAVE_INTERVAL_MS = 3000;

export type HeadlessIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
};

// The model-facing text for a prompt, built the way App's submit path builds it: a leading
// /<skill> is that skill's body (with the rest as extra guidance), otherwise @mentions and pasted
// URLs expand and a `triggers:` match may auto-inject. Returns the notices those steps produced
// so the caller can surface them; they never enter the model's context here either. With `confirm`
// (--interactive, #872) the skill and pasted-link questions are asked as the TUI asks them, before
// any expansion, so no fetch precedes the question; null (EOF, ctrl-c) is "send as typed".
export async function buildHeadlessInput(
  prompt: string,
  config: Config,
  bundle: ContextBundle,
  mode: HeadlessMode,
  confirm?: (spec: ConfirmSpec) => Promise<boolean | null>,
): Promise<{ modelText: string; skill?: string; notices: string[] }> {
  const notices: string[] = [];
  if (prompt.startsWith('/')) {
    const [name, ...rest] = prompt.slice(1).split(/\s+/);
    const skill = bundle.skills.find(s => s.name === name);
    if (!skill) throw new Error(`unknown skill /${name}`);
    const extra = rest.join(' ').trim();
    notices.push(
      `Skill /${skill.name} applied — its body was sent as this prompt${extra ? ', with your text after it' : ''}.`,
    );
    return {
      modelText: extra ? `${skill.body}\n\n${extra}` : skill.body,
      skill: skill.name,
      notices,
    };
  }
  const match = matchSkill(prompt, bundle.skills);
  // App.decideSkillRoute's gate: every mode but chat, and no word cap — a human is answering.
  const applySkill =
    confirm && match && config.skillAuto !== 'off' && mode !== 'chat'
      ? shouldConfirmInject(match, config.contextWindow) &&
        (await confirm(skillConfirmSpec(match))) === true
      : undefined;
  const urlPlan = planPastedUrls(prompt);
  const incidental =
    confirm && config.pasteFetch !== 'off' && urlPlan.urls.length > 0 && !urlPlan.request
      ? (await confirm(pastedUrlConfirmSpec(urlPlan.urls))) === true
      : undefined;
  const expansion = await expandMentions(prompt, bundle.cwd, { ocr: imageReader(config) });
  notices.push(...expansion.notices);
  // No `incidental` without --interactive: there is nobody to ask, so a link the prompt is not
  // about is left alone under 'ask' and fetched under 'apply' — the REIKA_SKILL_AUTO split.
  const urls = await expandPastedUrls(prompt, { mode: config.pasteFetch, incidental });
  notices.push(...urls.notices.map(n => n.text));
  let modelText = expansion.augmented;
  if (urls.blocks.length > 0) modelText = `${urls.blocks.join('\n\n')}\n\n${modelText}`;
  // Same exclusion as App.routeSkill: a skill body landing in plan mode competes with the plan
  // prompt. Headless has no one to suggest it to, so a non-injecting match is silent — and no one
  // to ask, so only 'apply' injects; the interactive default 'ask' sends the prompt as typed.
  const auto =
    applySkill ??
    (match &&
      config.skillAuto === 'apply' &&
      (mode === 'agent' || mode === 'vibe') &&
      shouldAutoInject(match, config.contextWindow));
  if (match && auto) {
    notices.push(
      `Skill /${match.skill.name} applied — its body was prepended to this prompt (matched: ${match.matched.join(', ')}).`,
    );
    return { modelText: `${match.skill.body}\n\n${modelText}`, skill: match.skill.name, notices };
  }
  return { modelText, notices };
}

// `--profile` is the user naming the profile outright, so it outranks a launch REIKA_MODEL and the
// mode's own model alike (#710). Matched case-insensitively like /model; a name no profile defines
// keeps the run going on the profile it would have used anyway, and says so — passed through raw,
// it reached the session as a profile nothing defines and lost the default's probed window.
export function headlessProfile(
  config: Config,
  mode: HeadlessMode,
  named?: string,
): { profile: string; notice?: string } {
  const fallback = startProfiles(config, mode, {}).profile;
  if (named === undefined) return { profile: fallback };
  const key = named.toLowerCase();
  if (config.profiles[key]) return { profile: key };
  const known = Object.keys(config.profiles).join(', ');
  return {
    profile: fallback,
    notice: `no profile named "${named}" (defined: ${known}); using "${fallback}"`,
  };
}

// Names the route the turn was on, since with --profile it may not be the default one. Not worded
// as a fetch failure: an abort, a 400 or a tool throw lands here too.
export function formatTurnFailure(profile: string, baseURL: string, message: string): string {
  return `reika: turn failed (profile "${profile}" at ${baseURL}): ${message}`;
}

export async function runHeadless(args: HeadlessArgs, io: HeadlessIo): Promise<number> {
  const prompt = (args.prompt ?? (await io.readStdin())).trim();
  if (!prompt) {
    io.stderr('reika: no prompt given\n');
    return 1;
  }

  // Opened before the session, since it decides the tool list: ask_user is offered only when
  // someone can answer it. Its reads end on the turn's abort, so ctrl-c at a menu stops the run.
  const controller = new AbortController();
  let prompter: HeadlessPrompter | null = null;
  if (args.interactive) {
    prompter = openTerminalPrompter(controller.signal);
    if (!prompter) {
      io.stderr('reika: --interactive needs a terminal to ask on, and this run has none\n');
      return 1;
    }
  }
  try {
    return await runHeadlessTurn(args, io, prompt, controller, prompter);
  } finally {
    prompter?.close();
  }
}

async function runHeadlessTurn(
  args: HeadlessArgs,
  io: HeadlessIo,
  prompt: string,
  controller: AbortController,
  prompter: HeadlessPrompter | null,
): Promise<number> {
  // autoApprove is session-wide, not per-profile, so the loaded config decides the policy.
  // Unattended unless --interactive: with nobody to answer, a decline must not read as the user's.
  const loaded = { ...loadConfig(), unattended: !prompter };
  // "Always (this session)" lifts the policy to 'safe', as the TUI's toggle does.
  let policy = loaded.autoApprove;
  // The mode is settled before the session is created, because it decides the model (#616): a mode
  // with its own model in REIKA_MODE_MODELS runs that one, `--mode` or not. Headless has no /model
  // and no saved state — its env is the whole answer — so an empty state is the whole of #365 here.
  const mode: HeadlessMode = args.mode ?? resolveDefaultMode();
  const chosen = headlessProfile(loaded, mode, args.profile);
  if (chosen.notice) io.stderr(`reika: ${chosen.notice}\n`);
  const profile = chosen.profile;
  const stream = args.stream ? createStreamPrinter(io, args.json) : null;
  // Read lazily: the transcript belongs to the session created below.
  let transcript: () => Message[] = () => [];
  const tracked = createHeadlessStatus(() => transcript());
  // Assigned once the session exists: the file lives under the bundle's cwd.
  let autosave: HeadlessAutosave | null = null;
  const session = await createSession({
    cwd: process.cwd(),
    config: loaded,
    profile,
    canAsk: !!prompter,
    requestQuestion: prompter ? req => askQuestion(prompter, req) : undefined,
    requestApproval:
      loaded.autoApprove === 'bypass'
        ? undefined
        : async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
            if (autoApproves(policy, req)) return true;
            if (prompter) {
              const { answer, always } = await askApproval(prompter, req);
              if (always && policy === 'off') policy = 'safe';
              return answer;
            }
            io.stderr(
              `reika: declined ${toolLabel(req.tool)} (no prompt to ask at): ${firstLine(req.preview)}\n`,
            );
            return false;
          },
    events: {
      ...stream?.events,
      ...tracked.events,
      // The persistent receipts App puts in the scrollback — a fold, a declined URL, the
      // typecheck gate bouncing the model — are the ones a human watching a pipe should see.
      onMessage: msg => {
        if (msg.role === 'system') io.stderr(`reika: ${msg.content}\n`);
        stream?.onMessage(msg);
        autosave?.onMessage();
      },
    },
  });
  transcript = () => session.transcript;
  // MCP servers are this run's children: closed on every way out, so each gets its stdin EOF and a
  // moment to exit before `process.exit` would kill it outright (#594).
  try {
    const { config, bundle } = session;
    const meta = (midTurn: boolean): TranscriptMeta =>
      buildTranscriptMeta({
        msgs: session.transcript,
        model: config.model,
        baseURL: config.baseURL,
        cwd: bundle.cwd,
        mode,
        status: tracked.status(session),
        midTurn,
      });
    if (config.autosave) {
      autosave = createHeadlessAutosave(
        newSessionPath(projectHistoryDir(bundle.cwd), new Date(), processSessionStem()),
        () => session.transcript,
        mode === 'chat' ? 'chat' : 'agent',
        meta,
        message => io.stderr(`reika: auto-save failed: ${message}\n`),
      );
    }
    if (session.limitsNotice) io.stderr(`reika: ${session.limitsNotice}\n`);
    if (session.windowNotice) io.stderr(`reika: ${session.windowNotice}\n`);
    if (session.offline)
      io.stderr('reika: no network — search and fetch_url are off for this run\n');
    if (session.searchNotice) io.stderr(`reika: ${session.searchNotice}\n`);
    for (const notice of session.mcpNotices) io.stderr(`reika: ${notice}\n`);
    // The same startup line the TUI shows for a REIKA_MODE_MODELS entry it could not use (#616).
    for (const problem of config.modeModelErrors ?? []) io.stderr(`reika: ${problem}\n`);
    if (config.projectEnvNotice) io.stderr(`reika: ${config.projectEnvNotice}\n`);

    // An MCP tool typed as a slash command (#265): the same direct call the TUI makes, answered with
    // the tool's own output instead of a model turn. There is no question for the model to answer —
    // the user named the tool and its arguments — so this runs before any prompt is built.
    const mcpCall = prompt.includes('\n')
      ? undefined
      : findMcpCommand(prompt, session.mcp.commands);
    if (mcpCall) {
      const parsed = parseMcpArgs(mcpCall.command, mcpCall.rest);
      if ('error' in parsed) {
        io.stderr(`reika: ${parsed.error}\n`);
        return 1;
      }
      const { server, tool } = mcpCall.command;
      const { result, failed } = await callMcpTool(
        session.mcp.call,
        `${server}:${tool}`,
        server,
        tool,
        parsed.args,
      );
      io.stdout(`${result.payload ? `${result.payload}\n` : ''}`);
      io.stderr(`reika: ${result.summary}\n`);
      // A tool that failed is this run's error: the exit status is what a script reads, and the
      // summary on stderr is not something it can parse.
      return failed ? 1 : 0;
    }

    const input = await buildHeadlessInput(
      prompt,
      config,
      bundle,
      mode,
      prompter ? spec => askConfirm(prompter, spec) : undefined,
    );
    for (const n of input.notices) io.stderr(`reika: ${n}\n`);

    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);

    let failed: Error | null = null;
    try {
      await session.submit(input.modelText, {
        mode,
        display: prompt,
        skill: input.skill,
        signal: controller.signal,
      });
    } catch (e) {
      failed = e as Error;
    } finally {
      process.off('SIGINT', onSigint);
      stream?.finish();
    }
    const appended = session.transcript;
    await autosave?.finish();

    if (args.save) {
      try {
        const { jsonlPath } = await saveTranscript(
          join(homedir(), '.config', 'reika', 'history'),
          appended,
          meta(false),
        );
        io.stderr(`reika: saved ${appended.length} messages → ${jsonlPath}\n`);
      } catch (e) {
        io.stderr(`reika: save failed: ${(e as Error).message}\n`);
      }
    }

    if (failed) {
      debugLog(`headless: turn failed: ${failed.message}`);
      io.stderr(`${formatTurnFailure(profile, config.baseURL, failed.message)}\n`);
      return controller.signal.aborted ? 130 : 1;
    }
    if (args.json && !args.stream) {
      io.stdout(`${JSON.stringify(appended)}\n`);
    }
    // An interrupted turn commits an `(aborted)` assistant message so the history reads right; on
    // a pipe that is not a reply, and the exit status already says what happened.
    if (controller.signal.aborted) {
      io.stderr('reika: interrupted\n');
      return 130;
    }
    const reply = finalReply(appended);
    if (!args.json && !args.stream && reply) io.stdout(`${reply}\n`);
    return reply ? 0 : 1;
  } finally {
    await session.mcp.close();
  }
}

// The status-line operands the session does not keep itself, tracked the way App tracks them so the
// saved header is the TUI's (#871): the pre-send estimate, each shed or fold stamped with its turn,
// and the last call's usage dropped once a shrink has made it stale.
export function createHeadlessStatus(messages: () => Message[]): {
  events: Pick<SessionEvents, 'onUsage' | 'onContextEstimate' | 'onShrink'>;
  status: (session: {
    config: Pick<Config, 'contextWindow' | 'minGenTokens'>;
    totals: Usage;
    shrink: TranscriptStatus['shrink'];
  }) => TranscriptStatus;
} {
  let lastUsage: Usage | null = null;
  let estimatedContext: number | null = null;
  const shrinkEvents: TranscriptShrinkEvent[] = [];
  return {
    events: {
      onUsage: u => (lastUsage = u),
      onContextEstimate: t => (estimatedContext = t),
      onShrink: event => {
        lastUsage = null;
        const turn = messages().filter(m => m.role === 'assistant').length + 1;
        shrinkEvents.push({ turn, ...event });
      },
    },
    status: session => ({
      totals: session.totals,
      lastUsage,
      estimatedContext,
      shrink: session.shrink,
      shrinkEvents: [...shrinkEvents],
      contextWindow: session.config.contextWindow,
      minGenTokens: session.config.minGenTokens,
    }),
  };
}

export type HeadlessAutosave = { onMessage: () => void; finish: () => Promise<void> };

// Auto-save for a headless run (#871): the TUI's file, in the TUI's place, so /resume lists a
// `reika -p` run beside the interactive ones. Written on the first real prompt, at most once per
// interval while the turn runs (a long unattended turn is exactly the one a crash should not take
// whole), and once more at the end. Writes are chained so an older snapshot never lands last.
// A chat run is the chat side of the file, as the TUI writes it: chat history is isolated from
// the other modes, and a /resume of it must not land in agent history.
export function createHeadlessAutosave(
  path: string,
  messages: () => Message[],
  side: keyof SessionSides,
  meta: (midTurn: boolean) => TranscriptMeta,
  onError: (message: string) => void,
  intervalMs = AUTOSAVE_INTERVAL_MS,
): HeadlessAutosave {
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let written = false;
  let failed = false;
  const save = (midTurn: boolean): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const msgs = messages();
    // An MCP command or a turn that never reached its user echo is not a session worth listing.
    if (countRealTurns(msgs) === 0) return chain;
    if (!written) debugLog(`[reika:debug] session file=${basename(path)}`);
    written = true;
    const sides: SessionSides = { agent: [], chat: [], [side]: [...msgs] };
    const header = meta(midTurn);
    chain = chain
      .then(() => writeSession(path, sides, header))
      .catch((e: unknown) => {
        // Said once: a full disk fails every save the same way.
        if (failed) return;
        failed = true;
        onError((e as Error).message);
      });
    return chain;
  };
  return {
    onMessage: () => {
      if (!written) {
        void save(true);
        return;
      }
      if (timer !== null) return;
      timer = setTimeout(() => void save(true), intervalMs);
      timer.unref?.();
    },
    finish: () => save(false),
  };
}

// --stream (#566). Text: the content channel goes to stdout as it arrives and each tool call's
// summary to stderr, so a pipe reads like the TUI minus the reasoning. What streams can't be taken
// back, so the two things the TUI streams and then replaces stay off stdout: a subagent's rounds
// (its report reaches the parent as a tool result) and the compaction note (a digest for the
// model, not a reply). JSON: each committed message is one NDJSON line — the objects --json
// prints as an array at the end, so a consumer can switch between the two without a new schema.
export function createStreamPrinter(
  io: Pick<HeadlessIo, 'stdout' | 'stderr'>,
  json: boolean,
): { events: SessionEvents; onMessage: (msg: Message) => void; finish: () => void } {
  if (json) {
    return {
      events: {},
      onMessage: msg => io.stdout(`${JSON.stringify(msg)}\n`),
      finish: () => {},
    };
  }
  let wrote = false;
  let lineOpen = false;
  let roundStarted = false;
  let subagent = false;
  let note = false;
  const endLine = (): void => {
    if (lineOpen) io.stdout('\n');
    lineOpen = false;
  };
  const endRound = (): void => {
    endLine();
    roundStarted = false;
  };
  return {
    events: {
      onPhase: endRound,
      onSubagent: live => (subagent = live),
      onCompactionNote: live => (note = live),
      onContentDelta: delta => {
        if (subagent || note) return;
        if (!roundStarted) {
          // A model often opens with blank lines; a round's first visible text starts the block.
          delta = delta.trimStart();
          if (!delta) return;
          roundStarted = true;
          if (wrote) io.stdout('\n');
        }
        io.stdout(delta);
        wrote = true;
        lineOpen = !delta.endsWith('\n');
      },
    },
    onMessage: msg => {
      if (msg.role === 'assistant') endRound();
      if (msg.role === 'tool' && !subagent) {
        io.stderr(`reika: ↳ ${firstLine(msg.summary)}\n`);
      }
    },
    finish: endLine,
  };
}

// The last assistant message with content is the answer. A turn that ended on a tool call or an
// empty message has no reply, which the exit status reports.
export function finalReply(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content?.trim()) return m.content.trim();
  }
  return null;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
