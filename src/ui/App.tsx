import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Splash } from './Splash.js';
import { Scrollback } from './Scrollback.js';
import { VERSION } from '../version.js';
import { Input } from './Input.js';
import { Working } from './Working.js';
import { Status } from './Status.js';
import { Approval } from './Approval.js';
import { loadConfig, resolveProfile } from '../config.js';
import { bootstrap } from '../context/bootstrap.js';
import { chatTools, defaultTools } from '../tools/index.js';
import { PayloadStore } from '../store/payloads.js';
import { runTurn } from '../agent/loop.js';
import { execStream } from '../tools/bash.js';
import { expandMentions } from '../agent/mentions.js';
import { Suggestions } from './Suggestions.js';
import { acceptSuggestion, computeSuggestions, type SuggestionState } from './suggest.js';
import { buildSummary, hasActivity, type Approvals } from './summary.js';
import type { ApprovalRequest, Config, ContextBundle, Message, Usage } from '../types.js';

type Phase = 'thinking' | 'tool';
type UIStatus = 'loading' | 'idle' | 'busy' | 'error';
type Mode = 'agent' | 'shell' | 'chat';

// Only the startup splash lives in the dedicated header <Static>. The compact
// header (after /cd or /model) flows through the message stream instead — Ink
// honors a single <Static>, so appending to this one after the message log's
// Static takes over would render nowhere.
type HeaderItem = { kind: 'splash'; model: string; cwd: string; version: string; subagent?: string };

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
  const [pending, setPending] = useState<{
    request: ApprovalRequest;
    resolve: (allow: boolean) => void;
  } | null>(null);
  const [approvalSelected, setApprovalSelected] = useState(0);
  const [mode, setMode] = useState<Mode>('agent');
  const [activeProfile, setActiveProfile] = useState<string>('default');
  const [headerItems, setHeaderItems] = useState<HeaderItem[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  const [suggestionState, setSuggestionState] = useState<SuggestionState | null>(null);
  const [suggestionSelected, setSuggestionSelected] = useState(0);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  const [approvals, setApprovals] = useState<Approvals>({ approved: 0, declined: 0 });
  const [exitRequested, setExitRequested] = useState(false);
  const [sessionAutoApprove, setSessionAutoApprove] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
      if (pendingRef.current) {
        pendingRef.current.resolve(false);
        setPending(null);
      }
      if (statusRef.current === 'busy' && abortRef.current) {
        abortRef.current.abort();
      } else {
        requestExit();
      }
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
    if (sessionAutoApproveRef.current && !hasWarnings) {
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
    const echo: Message = { role: 'user', content: raw };

    if (name === 'clear' || name === 'new') {
      setMessages([]);
      setTotalUsage({ promptTokens: 0, completionTokens: 0 });
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
    if (name === 'shell' || name === 'agent' || name === 'chat') {
      const banner =
        name === 'shell'
          ? 'Shell mode. Commands run directly in cwd. /agent to return.'
          : name === 'chat'
            ? 'Chat mode. Filesystem and shell tools disabled. Conversation isolated from agent. /agent to return.'
            : 'Agent mode.';
      switchMode(name, banner, echo);
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
          '  /model             show current model and base URL',
          '  /cwd               show working directory',
          '  /tokens            show token usage this session',
          '  /stats             show full session summary',
          '  /exit, /quit       exit reika (prints summary)',
          '  @<path>            in agent mode, inline a file as context',
        ].join('\n');
        break;
      case 'model': {
        if (!config) {
          response = 'config not loaded';
          break;
        }
        const target = args.trim().toLowerCase();
        if (target) {
          if (!config.profiles[target]) {
            const avail = Object.keys(config.profiles).join(', ');
            response = `Unknown profile: ${target}. Available: ${avail}`;
            break;
          }
          setActiveProfile(target);
          const next = config.profiles[target];
          setMessages(prev => [
            ...prev,
            echo,
            ...(bundle
              ? [{ role: 'header' as const, model: next.model, cwd: bundle.cwd }]
              : []),
            { role: 'system', content: `Switched to profile '${target}' (${next.model})` },
          ]);
          return;
        }
        const current = config.profiles[activeProfile] ?? config.profiles.default;
        const list = Object.entries(config.profiles)
          .map(([n, p]) => `  ${n === activeProfile ? '›' : ' '} ${n} → ${p.model}`)
          .join('\n');
        const lines = [
          `current: ${activeProfile}`,
          `model:    ${current.model}`,
          `base:     ${current.baseURL}`,
        ];
        if (config.subagentModel && config.subagentModel !== current.model) {
          lines.push(`subagent: ${config.subagentModel}`);
        }
        lines.push('', 'available profiles:', list, '', 'switch with /model <name>');
        response = lines.join('\n');
        break;
      }
      case 'approvals': {
        const envOn = config?.autoApprove === true;
        const target = args.trim().toLowerCase();
        if (target === 'on' || target === 'off') {
          if (envOn) {
            response = `auto-approve is forced on by REIKA_AUTO_APPROVE; session toggle has no effect.`;
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
        const effective = envOn || sessionAutoApprove;
        response = [
          `auto-approve: ${effective ? 'on' : 'off'}`,
          `  source: ${envOn ? 'REIKA_AUTO_APPROVE (env)' : sessionAutoApprove ? 'session toggle' : '(disabled)'}`,
          '',
          envOn
            ? 'env REIKA_AUTO_APPROVE forces on; session toggle is shadowed'
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
    const echo: Message = { role: 'user', content: command };
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

  const submitToModel = async (modelText: string, displayOverride?: string): Promise<void> => {
    if (!config || !bundle) return;
    setStatus('busy');
    setPhase('thinking');
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
        tools: mode === 'chat' ? chatToolsList : tools,
        payloads,
        signal: controller.signal,
        requestApproval: config.autoApprove ? undefined : requestApproval,
        promptMode: mode === 'chat' ? 'chat' : 'agent',
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
        onPhase: p => setPhase(p),
        onUsage: u =>
          setTotalUsage(t => ({
            promptTokens: t.promptTokens + u.promptTokens,
            completionTokens: t.completionTokens + u.completionTokens,
          })),
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
          {status === 'busy' && pending === null ? <Working /> : null}
          <Input
            disabled={pending !== null}
            canSubmit={status === 'idle' && pending === null}
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
            autoApprove={config?.autoApprove || sessionAutoApprove}
            modeTag={mode === 'agent' ? undefined : mode}
          />
        </>
      )}
    </Box>
  );
}
