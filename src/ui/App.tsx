import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Splash } from './Splash.js';
import { Scrollback } from './Scrollback.js';
import { VERSION } from '../version.js';
import { Input } from './Input.js';
import { Working } from './Working.js';
import { Status } from './Status.js';
import { theme } from './theme.js';
import { Approval } from './Approval.js';
import { loadConfig, resolveProfile } from '../config.js';
import { bootstrap } from '../context/bootstrap.js';
import { addFileToIndex } from '../context/files.js';
import { chatTools, defaultTools, planTools } from '../tools/index.js';
import { PayloadStore } from '../store/payloads.js';
import { saveTranscript, TRANSCRIPT_VERSION } from '../store/transcript.js';
import { runTurn } from '../agent/loop.js';
import { execStream } from '../tools/bash.js';
import { expandMentions } from '../agent/mentions.js';
import { Suggestions } from './Suggestions.js';
import { buildImplementPrompt } from './commands.js';
import { acceptSuggestion, computeSuggestions, type SuggestionState } from './suggest.js';
import { buildSummary, hasActivity, type Approvals } from './summary.js';
import type { ApprovalRequest, Config, ContextBundle, Message, Usage } from '../types.js';

type Phase = 'thinking' | 'tool';
type UIStatus = 'loading' | 'idle' | 'busy' | 'error';
type Mode = 'agent' | 'shell' | 'chat' | 'plan';

// How long the "Typechecking" indicator lingers after a check settles, so a sub-second warm check
// still reads. Long enough to perceive, short enough not to imply the check is still running.
const TYPECHECK_LINGER_MS = 650;

// Only the startup splash lives in the dedicated header <Static>. The compact
// header (after /cd or /model) flows through the message stream instead — Ink
// honors a single <Static>, so appending to this one after the message log's
// Static takes over would render nowhere.
type HeaderItem = {
  kind: 'splash';
  model: string;
  cwd: string;
  version: string;
  subagent?: string;
};

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

export function App() {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<UIStatus>('loading');
  const [phase, setPhase] = useState<Phase>('thinking');
  // True while the harness is running a post-edit typecheck; relabels the busy indicator so the
  // verification is visible in the dispatch gap. Human-only — never part of model context.
  const [typechecking, setTypechecking] = useState<boolean>(false);
  // True while the current reasoning block looks like it may be spinning (long AND repetitive).
  // Relabels the busy indicator so the user can decide to abort (ctrl-c) or wait it out. A soft
  // hint, not an automated cutoff — human-only, never part of model context. See loop.ts.
  const [reasoningSpin, setReasoningSpin] = useState<boolean>(false);
  const [streaming, setStreaming] = useState<string>('');
  const [streamingReasoning, setStreamingReasoning] = useState<string>('');
  const [streamingTool, setStreamingTool] = useState<string>('');
  const [config, setConfig] = useState<Config | null>(null);
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ReturnType<typeof defaultTools>>(() => defaultTools());
  const [chatToolsList, setChatToolsList] = useState<ReturnType<typeof chatTools>>(() => []);
  const [payloads] = useState(() => new PayloadStore());
  const [elapsed, setElapsed] = useState(0);
  const [totalUsage, setTotalUsage] = useState<Usage>({ promptTokens: 0, completionTokens: 0 });
  // Most recent call's usage (the authoritative current context size + cache hit rate),
  // and the pre-send estimate used to fill the gauge before that real count arrives.
  const [lastUsage, setLastUsage] = useState<Usage | null>(null);
  const [estimatedContext, setEstimatedContext] = useState<number | null>(null);
  // Learned char→token calibration for the context estimate, persisted across turns so the
  // first call of each turn (which re-seeds the full history) triggers compaction accurately.
  const calibrationRef = useRef(1);
  const [pending, setPending] = useState<{
    request: ApprovalRequest;
    resolve: (allow: boolean) => void;
  } | null>(null);
  const [approvalSelected, setApprovalSelected] = useState(0);
  // REIKA_PLAN_EXPERIMENT=1 starts the session in plan mode (A/B convenience); /plan and /agent
  // toggle it at any time regardless.
  const [mode, setMode] = useState<Mode>(
    process.env.REIKA_PLAN_EXPERIMENT === '1' ? 'plan' : 'agent',
  );
  const [activeProfile, setActiveProfile] = useState<string>('default');
  const [headerItems, setHeaderItems] = useState<HeaderItem[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  // Past submissions (oldest→newest) the Input recalls via ArrowUp/ArrowDown,
  // independent of the chat transcript so it spans chat, shell, and commands.
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [suggestionState, setSuggestionState] = useState<SuggestionState | null>(null);
  const [suggestionSelected, setSuggestionSelected] = useState(0);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  const [approvals, setApprovals] = useState<Approvals>({ approved: 0, declined: 0 });
  const [exitRequested, setExitRequested] = useState(false);
  const [exitArmed, setExitArmed] = useState(false);
  const [sessionAutoApprove, setSessionAutoApprove] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const exitArmedRef = useRef(false);
  exitArmedRef.current = exitArmed;
  const exitTimerRef = useRef<NodeJS.Timeout | null>(null);
  // A warm incremental typecheck can return in well under a second; without a floor the indicator
  // flashes too briefly to register. Hold the "Typechecking" state a beat after the check settles so
  // it's actually perceptible. See onTypecheckChange / resetTypecheck.
  const typecheckHideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const disarmExit = (): void => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setExitArmed(false);
  };
  const statusRef = useRef<UIStatus>('loading');
  statusRef.current = status;
  const pendingRef = useRef<typeof pending>(null);
  pendingRef.current = pending;
  const approvalSelectedRef = useRef(0);
  approvalSelectedRef.current = approvalSelected;
  const sessionAutoApproveRef = useRef(false);
  sessionAutoApproveRef.current = sessionAutoApprove;
  const modeRef = useRef<Mode>('agent');
  modeRef.current = mode;
  const activeProfileRef = useRef('default');
  activeProfileRef.current = activeProfile;
  const inputValueRef = useRef('');
  inputValueRef.current = inputValue;
  const suggestionStateRef = useRef<SuggestionState | null>(null);
  suggestionStateRef.current = suggestionState;
  const suggestionSelectedRef = useRef(0);
  suggestionSelectedRef.current = suggestionSelected;
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  // Stash for the inactive side of the chat/agent boundary. Shell shares with agent.
  const stashedMessagesRef = useRef<{ agent?: Message[]; chat?: Message[] }>({});
  const usageRef = useRef<Usage>({ promptTokens: 0, completionTokens: 0 });
  usageRef.current = totalUsage;
  const sessionStartedAtRef = useRef(sessionStartedAt);
  sessionStartedAtRef.current = sessionStartedAt;
  const approvalsRef = useRef<Approvals>({ approved: 0, declined: 0 });
  approvalsRef.current = approvals;
  const streamingRef = useRef<string>('');
  const reasoningRef = useRef<string>('');
  const toolRef = useRef<string>('');
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reasoningFlushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const toolFlushTimerRef = useRef<NodeJS.Timeout | null>(null);

  const scheduleFlush = (): void => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      setStreaming(streamingRef.current);
    }, 50);
  };

  const scheduleReasoningFlush = (): void => {
    if (reasoningFlushTimerRef.current !== null) return;
    reasoningFlushTimerRef.current = setTimeout(() => {
      reasoningFlushTimerRef.current = null;
      setStreamingReasoning(reasoningRef.current);
    }, 50);
  };

  const scheduleToolFlush = (): void => {
    if (toolFlushTimerRef.current !== null) return;
    toolFlushTimerRef.current = setTimeout(() => {
      toolFlushTimerRef.current = null;
      setStreamingTool(toolRef.current);
    }, 50);
  };

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const b = await bootstrap(process.cwd(), cfg.repoMapBudget);
        setConfig(cfg);
        setBundle(b);
        setTools(defaultTools(cfg));
        setChatToolsList(chatTools(cfg));
        setHeaderItems(prev => [
          ...prev,
          {
            kind: 'splash',
            model: cfg.model,
            cwd: b.cwd,
            version: VERSION,
            subagent:
              cfg.subagentModel && cfg.subagentModel !== cfg.model ? cfg.subagentModel : undefined,
          },
        ]);
        setStatus('idle');
      } catch (e) {
        setError((e as Error).message);
        setStatus('error');
      }
    })();
  }, []);

  useEffect(
    () => () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!exitRequested) return;
    // Defer one tick so the just-pushed summary message renders before we unmount.
    const id = setTimeout(() => exit(), 0);
    return () => clearTimeout(id);
  }, [exitRequested, exit]);

  useEffect(() => {
    if (status !== 'busy') {
      setElapsed(0);
      startedAtRef.current = null;
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
  }, [status]);

  useEffect(() => {
    // Pause the elapsed-time interval while an approval is pending — every tick
    // re-renders the live region, which trips the xterm.js scroll-jump bug.
    if (status !== 'busy' || pending !== null) return;
    const id = setInterval(() => {
      if (startedAtRef.current != null) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [status, pending]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const hadPending = pendingRef.current !== null;
      // Interrupt anything in flight: decline a pending approval, abort a turn.
      if (hadPending) {
        pendingRef.current!.resolve(false);
        setPending(null);
      }
      if (statusRef.current === 'busy' && abortRef.current) {
        abortRef.current.abort();
        return;
      }
      if (hadPending) return;
      // Idle. A non-empty input clears first — catches the common accidental tap.
      if (inputValueRef.current.length > 0) {
        setInputValue('');
        setSuggestionState(null);
        disarmExit();
        return;
      }
      // Empty input: require a second Ctrl+C within the window to actually exit.
      if (exitArmedRef.current) {
        disarmExit();
        requestExit();
        return;
      }
      setExitArmed(true);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        setExitArmed(false);
      }, 1500);
      return;
    }
    if (pendingRef.current) {
      if (key.upArrow) {
        setApprovalSelected(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setApprovalSelected(i => Math.min(2, i + 1));
        return;
      }
      if (key.return) {
        const sel = approvalSelectedRef.current;
        const resolve = pendingRef.current.resolve;
        setPending(null);
        if (sel === 0) resolve(true);
        else if (sel === 1) resolve(false);
        else {
          setSessionAutoApprove(true);
          resolve(true);
        }
        return;
      }
      if (input === 'y' || input === 'Y') {
        pendingRef.current.resolve(true);
        setPending(null);
      } else if (input === 'n' || input === 'N') {
        pendingRef.current.resolve(false);
        setPending(null);
      }
      return;
    }
    const sug = suggestionStateRef.current;
    if (sug && sug.items.length > 0) {
      if (key.upArrow) {
        setSuggestionSelected(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestionSelected(i => Math.min(sug.items.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = sug.items[suggestionSelectedRef.current];
        if (sel) {
          const next = acceptSuggestion(inputValueRef.current, sel, sug.partial);
          setInputValue(next);
          setSuggestionState(null);
        }
        return;
      }
      if (key.escape) {
        setSuggestionState(null);
        return;
      }
    }
  });

  const requestExit = (): void => {
    if (hasActivity(messagesRef.current)) {
      const summary = buildSummary(
        messagesRef.current,
        usageRef.current,
        sessionStartedAtRef.current,
        approvalsRef.current,
      );
      setMessages(prev => [...prev, { role: 'system', content: summary }]);
    }
    setExitRequested(true);
  };

  const onInputChange = (value: string): void => {
    setInputValue(value);
    if (!bundle) {
      setSuggestionState(null);
      return;
    }
    const next = computeSuggestions(value, bundle.fileIndex, bundle.skills);
    setSuggestionState(next);
    setSuggestionSelected(0);
  };

  const requestApproval = (req: ApprovalRequest): Promise<boolean> => {
    const hasWarnings = !!req.warnings && req.warnings.length > 0;
    // 'safe' (env) and the session toggle both auto-approve ordinary actions, but a flagged
    // dangerous command still falls through to the prompt. 'bypass' never reaches here —
    // requestApproval is undefined in that mode (see runTurn wiring below).
    const envSafe = config?.autoApprove === 'safe';
    if ((sessionAutoApproveRef.current || envSafe) && !hasWarnings) {
      setApprovals(a => ({ ...a, approved: a.approved + 1 }));
      return Promise.resolve(true);
    }
    setApprovalSelected(0);
    return new Promise(resolve => {
      const wrappedResolve = (allow: boolean): void => {
        setApprovals(a =>
          allow ? { ...a, approved: a.approved + 1 } : { ...a, declined: a.declined + 1 },
        );
        resolve(allow);
      };
      setPending({ request: req, resolve: wrappedResolve });
    });
  };

  const switchMode = (next: Mode, banner: string, echo: Message): void => {
    if (next === mode) {
      setMessages(prev => [...prev, echo, { role: 'system', content: `Already in ${next} mode.` }]);
      return;
    }
    if (statusRef.current === 'busy') {
      setMessages(prev => [
        ...prev,
        echo,
        { role: 'system', content: 'Cannot switch modes while busy. Wait or ctrl-c to abort.' },
      ]);
      return;
    }
    const currentIsChat = mode === 'chat';
    const nextIsChat = next === 'chat';
    const switchMsg: Message = { role: 'system', content: banner };
    if (currentIsChat !== nextIsChat) {
      // Crossing the chat boundary — save current array, restore the other side's stash
      const stash = stashedMessagesRef.current;
      if (currentIsChat) {
        stash.chat = messagesRef.current;
      } else {
        stash.agent = messagesRef.current;
      }
      const restored = (nextIsChat ? stash.chat : stash.agent) ?? [];
      setMessages([...restored, echo, switchMsg]);
    } else {
      setMessages(prev => [...prev, echo, switchMsg]);
    }
    setMode(next);
  };

  const handleCommand = async (raw: string): Promise<void> => {
    const rest = raw.slice(1);
    const space = rest.indexOf(' ');
    const name = (space === -1 ? rest : rest.slice(0, space)).toLowerCase();
    const args = space === -1 ? '' : rest.slice(space + 1);
    // `meta` keeps this command echo in the scrollback but out of the model-facing history.
    const echo: Message = { role: 'user', content: raw, meta: true };

    if (name === 'clear' || name === 'new') {
      setMessages([]);
      setTotalUsage({ promptTokens: 0, completionTokens: 0 });
      setLastUsage(null);
      setEstimatedContext(null);
      calibrationRef.current = 1;
      setApprovals({ approved: 0, declined: 0 });
      setSessionStartedAt(Date.now());
      setSessionAutoApprove(false);
      setMode('agent');
      setActiveProfile('default');
      return;
    }
    if (name === 'exit' || name === 'quit') {
      requestExit();
      return;
    }
    if (name === 'stats') {
      const content = hasActivity(messagesRef.current)
        ? buildSummary(
            messagesRef.current,
            usageRef.current,
            sessionStartedAtRef.current,
            approvalsRef.current,
          )
        : 'No activity yet.';
      setMessages(prev => [...prev, echo, { role: 'system', content }]);
      return;
    }
    if (name === 'shell' || name === 'agent' || name === 'chat' || name === 'plan') {
      const banner =
        name === 'shell'
          ? 'Shell mode. Commands run directly in cwd. /agent to return.'
          : name === 'chat'
            ? 'Chat mode. Filesystem and shell tools disabled. Conversation isolated from agent. /agent to return.'
            : name === 'plan'
              ? 'Plan mode — read-only exploration; will end with a written plan. /agent to execute it.'
              : 'Agent mode.';
      switchMode(name, banner, echo);
      return;
    }
    if (name === 'implement') {
      // Shortcut for the plan→agent handoff: flip to agent mode and submit "execute the plan
      // above" so the user doesn't have to /agent then hand-write the prompt. The plan sits in
      // `messages` from prior renders, so it's in the history slice submitToModel sends; with
      // REIKA_PLAN_HANDOFF=1 the loop folds the exploration into a digest automatically.
      if (mode === 'shell' || mode === 'chat') {
        setMessages(prev => [
          ...prev,
          echo,
          {
            role: 'system',
            content: `/implement isn't available in ${mode} mode — use it from plan mode (or agent mode) to execute a plan.`,
          },
        ]);
        return;
      }
      if (mode === 'plan') {
        setMode('agent');
        setMessages(prev => [
          ...prev,
          { role: 'system', content: 'Agent mode — implementing the plan above.' },
        ]);
      }
      // The user bubble renders as `/implement` (displayOverride) while the model receives the
      // built prompt; 'agent' forces this turn's tools + promptMode regardless of the not-yet-
      // flushed mode state.
      await submitToModel(buildImplementPrompt(args), raw, 'agent');
      return;
    }
    if (name === 'cd') {
      const target = args.trim();
      if (!target) {
        setMessages(prev => [...prev, echo, { role: 'system', content: 'Usage: /cd <path>' }]);
        return;
      }
      if (!bundle || !config) return;
      const expanded = expandHome(target);
      const newCwd = isAbsolute(expanded) ? expanded : resolve(bundle.cwd, expanded);
      setStatus('busy');
      setMessages(prev => [...prev, echo, { role: 'system', content: `Re-indexing ${newCwd}…` }]);
      try {
        const newBundle = await bootstrap(newCwd, config.repoMapBudget);
        setBundle(newBundle);
        setMessages(prev => [
          ...prev,
          { role: 'header', model: config.model, cwd: newBundle.cwd },
          { role: 'system', content: `cwd is now ${newCwd}` },
        ]);
      } catch (e) {
        setMessages(prev => [
          ...prev,
          { role: 'system', content: `cd failed: ${(e as Error).message}` },
        ]);
      } finally {
        setStatus('idle');
      }
      return;
    }

    if (name === 'save') {
      if (!config || !bundle) return;
      const raw = args.trim().toLowerCase() === '--raw';
      const msgs = messagesRef.current;
      if (msgs.length === 0) {
        setMessages(prev => [...prev, echo, { role: 'system', content: 'Nothing to save yet.' }]);
        return;
      }
      // Use the active profile's model/base so the saved meta reflects what was actually running,
      // not the default. Stamp savedAt here (the serializer is pure and takes no clock).
      const profile = config.profiles[activeProfileRef.current] ?? config.profiles.default;
      try {
        const { jsonlPath, txtPath } = await saveTranscript(
          join(homedir(), '.config', 'reika', 'history'),
          msgs,
          {
            version: TRANSCRIPT_VERSION,
            savedAt: new Date().toISOString(),
            model: profile.model,
            baseURL: profile.baseURL,
            cwd: bundle.cwd,
            messageCount: msgs.length,
          },
          { redact: !raw },
        );
        setMessages(prev => [
          ...prev,
          echo,
          {
            role: 'system',
            content: `saved ${msgs.length} messages${raw ? ' (raw, unredacted)' : ''} → ${jsonlPath}\n(+ ${txtPath})`,
          },
        ]);
      } catch (e) {
        setMessages(prev => [
          ...prev,
          echo,
          { role: 'error', content: `save failed: ${(e as Error).message}` },
        ]);
      }
      return;
    }

    let response: string;
    switch (name) {
      case 'help':
        response = [
          'Commands:',
          '  /help              show this list',
          '  /new, /clear       reset conversation, tokens, mode',
          '  /cd <path>         change cwd (re-indexes repo map)',
          '  /shell             enter shell mode (raw bash, no model)',
          '  /chat              enter chat mode (no filesystem/shell tools; isolated)',
          '  /agent             return to agent mode',
          '  /implement         switch to agent mode and execute the plan above',
          '  /model             show current model and base URL',
          '  /cwd               show working directory',
          '  /tokens            show token usage this session',
          '  /stats             show full session summary',
          '  /save              save the full conversation to history (--raw skips redaction)',
          '  /exit, /quit       exit reika (prints summary)',
          '  @<path>            in agent mode, inline a file as context',
        ].join('\n');
        break;
      case 'model': {
        if (!config) {
          response = 'config not loaded';
          break;
        }
        const modelKeys = config.models.map(m => m.toLowerCase());
        const target = args.trim().toLowerCase();
        if (target) {
          if (!config.profiles[target]) {
            const avail = Object.keys(config.profiles).join(', ');
            response = `Unknown model/profile: ${target}. Available: ${avail}`;
            break;
          }
          setActiveProfile(target);
          const next = config.profiles[target];
          const kind = modelKeys.includes(target) ? 'model' : 'profile';
          setMessages(prev => [
            ...prev,
            echo,
            ...(bundle ? [{ role: 'header' as const, model: next.model, cwd: bundle.cwd }] : []),
            { role: 'system', content: `Switched to ${kind} '${target}' (${next.model})` },
          ]);
          return;
        }
        const current = config.profiles[activeProfile] ?? config.profiles.default;
        const lines = [
          `current: ${activeProfile}`,
          `model:    ${current.model}`,
          `base:     ${current.baseURL}`,
        ];
        if (config.subagentModel && config.subagentModel !== current.model) {
          lines.push(`subagent: ${config.subagentModel}`);
        }
        // Models served by the default base URL. The first is active when activeProfile
        // is still 'default'; otherwise the marker follows the selected model name.
        const modelList = config.models
          .map((m, i) => {
            const active =
              activeProfile === m.toLowerCase() || (activeProfile === 'default' && i === 0);
            return `  ${active ? '›' : ' '} ${m}`;
          })
          .join('\n');
        lines.push('', 'models (default base url):', modelList);
        // Named profiles only — exclude 'default' and the auto-registered model entries.
        const namedProfiles = Object.entries(config.profiles).filter(
          ([n]) => n !== 'default' && !modelKeys.includes(n),
        );
        if (namedProfiles.length > 0) {
          const profileList = namedProfiles
            .map(([n, p]) => `  ${n === activeProfile ? '›' : ' '} ${n} → ${p.model}`)
            .join('\n');
          lines.push('', 'profiles:', profileList);
        }
        lines.push('', 'switch with /model <name>');
        response = lines.join('\n');
        break;
      }
      case 'approvals': {
        const envMode = config?.autoApprove ?? 'off';
        const envOn = envMode !== 'off';
        const target = args.trim().toLowerCase();
        if (target === 'on' || target === 'off') {
          if (envOn) {
            response = `auto-approve is forced to '${envMode}' by REIKA_AUTO_APPROVE; session toggle has no effect.`;
            break;
          }
          setSessionAutoApprove(target === 'on');
          response = `Session auto-approve: ${target}`;
          break;
        }
        if (target) {
          response = `Unknown argument: ${target}. Use /approvals on or /approvals off.`;
          break;
        }
        // Session toggle grants 'safe' behavior; env can force 'safe' or 'bypass'.
        const effectiveMode = envOn ? envMode : sessionAutoApprove ? 'safe' : 'off';
        const desc =
          effectiveMode === 'bypass'
            ? 'bypass — everything runs without confirmation, including dangerous commands'
            : effectiveMode === 'safe'
              ? 'safe — ordinary actions auto-run; dangerous commands still prompt'
              : 'off — every action asks first';
        response = [
          `auto-approve: ${effectiveMode}`,
          `  ${desc}`,
          `  source: ${envOn ? `REIKA_AUTO_APPROVE=${envMode} (env)` : sessionAutoApprove ? 'session toggle' : '(disabled)'}`,
          '',
          envOn
            ? 'env REIKA_AUTO_APPROVE forces this; session toggle is shadowed'
            : 'toggle with /approvals on or /approvals off',
        ].join('\n');
        break;
      }
      case 'cwd':
        response = bundle?.cwd ?? '(unknown)';
        break;
      case 'tokens':
        response = `prompt:     ${totalUsage.promptTokens}\ncompletion: ${totalUsage.completionTokens}`;
        break;
      case 'skills': {
        const list = bundle?.skills ?? [];
        if (list.length === 0) {
          response =
            'No skills loaded. Drop *.md files in ~/.config/reika/skills/ or <cwd>/.reika/skills/.';
        } else {
          response = [
            'Available skills (invoke as /<name>):',
            ...list.map(
              s =>
                `  /${s.name.padEnd(16)} ${s.description} ${s.source === 'project' ? '(project)' : ''}`,
            ),
          ].join('\n');
        }
        break;
      }
      default: {
        const skill = bundle?.skills.find(s => s.name === name);
        if (skill) {
          setMessages(prev => [...prev, echo]);
          const extra = args.trim();
          const prompt = extra ? `${skill.body}\n\n${extra}` : skill.body;
          await submitToModel(prompt, raw);
          return;
        }
        response = `Unknown command: /${name}. Try /help.`;
      }
    }
    setMessages(prev => [...prev, echo, { role: 'system', content: response }]);
  };

  const runShell = async (command: string): Promise<void> => {
    if (!bundle) return;
    // Shell mode is "raw bash, no model" — the command echo stays in the scrollback but is
    // kept out of the model history (its output, the `shell` message below, is UI-only too).
    const echo: Message = { role: 'user', content: command, meta: true };
    setMessages(prev => [...prev, echo]);
    setStatus('busy');
    toolRef.current = '';
    setStreamingTool('');
    try {
      const result = await execStream(command, {
        cwd: bundle.cwd,
        onProgress: chunk => {
          toolRef.current += chunk;
          scheduleToolFlush();
        },
      });
      const shellMsg: Message = {
        role: 'shell',
        command,
        output: result.payload ?? '',
      };
      setMessages(prev => [...prev, shellMsg]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'error', content: (e as Error).message }]);
    } finally {
      if (toolFlushTimerRef.current !== null) {
        clearTimeout(toolFlushTimerRef.current);
        toolFlushTimerRef.current = null;
      }
      toolRef.current = '';
      setStreamingTool('');
      setStatus('idle');
    }
  };

  const onSubmit = async (input: string) => {
    if (!config || !bundle || status !== 'idle') return;
    setInputValue('');
    setSuggestionState(null);
    const trimmed = input.trim();
    if (!trimmed) return;
    // Record for ArrowUp/ArrowDown recall, skipping consecutive duplicates.
    setInputHistory(prev => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
      return;
    }
    if (modeRef.current === 'shell') {
      await runShell(trimmed);
      return;
    }
    const { augmented, display } = await expandMentions(trimmed, bundle.cwd);
    await submitToModel(augmented, display !== augmented ? display : undefined);
  };

  // Latch the typecheck indicator: show immediately when a check starts, but defer hiding by
  // TYPECHECK_LINGER_MS so a fast check stays on screen long enough to see. A new check cancels a
  // pending hide so back-to-back checks read as continuous.
  const onTypecheckChange = (checking: boolean) => {
    if (typecheckHideTimerRef.current) {
      clearTimeout(typecheckHideTimerRef.current);
      typecheckHideTimerRef.current = null;
    }
    if (checking) {
      setTypechecking(true);
    } else {
      typecheckHideTimerRef.current = setTimeout(() => {
        setTypechecking(false);
        typecheckHideTimerRef.current = null;
      }, TYPECHECK_LINGER_MS);
    }
  };
  // Immediate, un-lingered clear for turn boundaries.
  const resetTypecheck = () => {
    if (typecheckHideTimerRef.current) {
      clearTimeout(typecheckHideTimerRef.current);
      typecheckHideTimerRef.current = null;
    }
    setTypechecking(false);
  };

  const submitToModel = async (
    modelText: string,
    displayOverride?: string,
    // For this turn only: overrides which mode's tools + prompt are used, bypassing the `mode`
    // closure. Needed by /implement, which flips to agent mode and submits in the same tick — the
    // setMode('agent') above hasn't flushed yet, so the closure would still read 'plan'.
    modeOverride?: Mode,
  ): Promise<void> => {
    if (!config || !bundle) return;
    const activeMode = modeOverride ?? mode;
    setStatus('busy');
    setPhase('thinking');
    resetTypecheck();
    setReasoningSpin(false);
    streamingRef.current = '';
    reasoningRef.current = '';
    toolRef.current = '';
    setStreaming('');
    setStreamingReasoning('');
    setStreamingTool('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runTurn({
        userInput: modelText,
        userDisplay: displayOverride,
        history: messages.slice(),
        bundle,
        config: resolveProfile(config, activeProfile),
        // Plan mode: read-only tools + the plan prompt. Chat mode: knowledge-only tools.
        tools: activeMode === 'chat' ? chatToolsList : activeMode === 'plan' ? planTools() : tools,
        payloads,
        signal: controller.signal,
        requestApproval: config.autoApprove === 'bypass' ? undefined : requestApproval,
        promptMode: activeMode === 'chat' ? 'chat' : activeMode === 'plan' ? 'plan' : 'agent',
        onMessage: msg => {
          if (msg.role === 'assistant') {
            streamingRef.current = '';
            reasoningRef.current = '';
            setStreaming('');
            setStreamingReasoning('');
          }
          if (msg.role === 'tool') {
            toolRef.current = '';
            setStreamingTool('');
            // Keep `@` autocomplete current with files the model writes this turn,
            // so a just-created file is attachable without a restart or /cd. The
            // diff path is relative (write/edit emit `relative(cwd, …)`), matching
            // fileIndex. addFileToIndex no-ops on existing/filtered paths.
            const written = msg.diff?.path;
            if (written) {
              setBundle(prev => {
                if (!prev) return prev;
                const next = addFileToIndex(prev.fileIndex, written, prev.ignore);
                return next === prev.fileIndex ? prev : { ...prev, fileIndex: next };
              });
            }
          }
          setMessages(prev => [...prev, msg]);
        },
        onContentDelta: delta => {
          streamingRef.current += delta;
          scheduleFlush();
        },
        onReasoningDelta: delta => {
          reasoningRef.current += delta;
          scheduleReasoningFlush();
        },
        onToolProgress: chunk => {
          toolRef.current += chunk;
          scheduleToolFlush();
        },
        onPhase: p => {
          // Leaving the thinking phase ends the reasoning block — clear any spin hint.
          if (p !== 'thinking') setReasoningSpin(false);
          setPhase(p);
        },
        onTypecheck: onTypecheckChange,
        onReasoningStatus: setReasoningSpin,
        onUsage: u => {
          setLastUsage(u);
          setTotalUsage(t => ({
            promptTokens: t.promptTokens + u.promptTokens,
            completionTokens: t.completionTokens + u.completionTokens,
            ...(u.cachedTokens != null
              ? { cachedTokens: (t.cachedTokens ?? 0) + u.cachedTokens }
              : t.cachedTokens != null
                ? { cachedTokens: t.cachedTokens }
                : {}),
          }));
        },
        onContextEstimate: t => setEstimatedContext(t),
        priorCalibration: calibrationRef.current,
        onCalibration: f => {
          calibrationRef.current = f;
        },
      });
    } catch (e) {
      setMessages(prev => [...prev, { role: 'error', content: (e as Error).message }]);
    } finally {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (reasoningFlushTimerRef.current !== null) {
        clearTimeout(reasoningFlushTimerRef.current);
        reasoningFlushTimerRef.current = null;
      }
      if (toolFlushTimerRef.current !== null) {
        clearTimeout(toolFlushTimerRef.current);
        toolFlushTimerRef.current = null;
      }
      streamingRef.current = '';
      reasoningRef.current = '';
      toolRef.current = '';
      setStreaming('');
      setStreamingReasoning('');
      setStreamingTool('');
      resetTypecheck();
      setReasoningSpin(false);
      setStatus('idle');
      abortRef.current = null;
    }
  };

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text bold>Error</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={headerItems}>
        {(h, i) => (
          <Splash key={i} model={h.model} cwd={h.cwd} version={h.version} subagent={h.subagent} />
        )}
      </Static>
      {status === 'loading' ? (
        <Text>Loading…</Text>
      ) : (
        <>
          <Scrollback
            messages={messages}
            streaming={status === 'busy' ? streaming : ''}
            streamingReasoning={status === 'busy' ? streamingReasoning : ''}
            streamingTool={status === 'busy' ? streamingTool : ''}
          />
          {pending ? (
            <Approval request={pending.request} selectedIndex={approvalSelected} />
          ) : suggestionState ? (
            <Suggestions state={suggestionState} selectedIndex={suggestionSelected} />
          ) : null}
          {status === 'busy' && pending === null ? (
            <Working
              // Typecheck (a definite harness action) takes priority over the soft spin hint.
              label={
                typechecking
                  ? 'Typechecking'
                  : reasoningSpin
                    ? 'Thinking — may be looping (ctrl-c to abort)'
                    : undefined
              }
              accent={typechecking ? theme.info : reasoningSpin ? theme.warning : undefined}
            />
          ) : null}
          <Input
            disabled={pending !== null}
            attachedAbove={pending !== null}
            canSubmit={status === 'idle' && pending === null}
            suggesting={!!suggestionState && suggestionState.items.length > 0}
            history={inputHistory}
            mode={mode}
            value={inputValue}
            onChange={onInputChange}
            onSubmit={onSubmit}
            placeholder={
              mode === 'shell' ? 'Run a shell command' : 'Type / for commands, @ to attach files'
            }
          />
          <Status
            model={config?.profiles[activeProfile]?.model ?? config?.model ?? ''}
            turns={messages.filter(m => m.role === 'assistant').length}
            status={status === 'busy' ? phase : status}
            elapsed={status === 'busy' ? elapsed : null}
            usage={totalUsage}
            contextTokens={lastUsage?.promptTokens ?? estimatedContext}
            contextWindow={config?.profiles[activeProfile]?.contextWindow ?? config?.contextWindow}
            cachedTokens={lastUsage?.cachedTokens}
            autoApprove={
              config?.autoApprove === 'bypass'
                ? 'bypass'
                : config?.autoApprove === 'safe' || sessionAutoApprove
                  ? 'safe'
                  : undefined
            }
            modeTag={mode}
            exitArmed={exitArmed && status === 'idle' && pending === null && inputValue === ''}
          />
        </>
      )}
    </Box>
  );
}
