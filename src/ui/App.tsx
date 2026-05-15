import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { Header } from './Header.js';
import { Scrollback } from './Scrollback.js';
import { Input } from './Input.js';
import { Status } from './Status.js';
import { Approval } from './Approval.js';
import { loadConfig } from '../config.js';
import { bootstrap } from '../context/bootstrap.js';
import { defaultTools } from '../tools/index.js';
import { PayloadStore } from '../store/payloads.js';
import { runTurn } from '../agent/loop.js';
import type { ApprovalRequest, Config, ContextBundle, Message } from '../types.js';

type Phase = 'thinking' | 'tool';
type UIStatus = 'loading' | 'idle' | 'busy' | 'error';

type HeaderItem = { model: string; cwd: string };

export function App() {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<UIStatus>('loading');
  const [phase, setPhase] = useState<Phase>('thinking');
  const [streaming, setStreaming] = useState<string>('');
  const [streamingReasoning, setStreamingReasoning] = useState<string>('');
  const [config, setConfig] = useState<Config | null>(null);
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tools] = useState(() => defaultTools());
  const [payloads] = useState(() => new PayloadStore());
  const [elapsed, setElapsed] = useState(0);
  const [pending, setPending] = useState<{
    request: ApprovalRequest;
    resolve: (allow: boolean) => void;
  } | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<UIStatus>('loading');
  statusRef.current = status;
  const pendingRef = useRef<typeof pending>(null);
  pendingRef.current = pending;
  const streamingRef = useRef<string>('');
  const reasoningRef = useRef<string>('');
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reasoningFlushTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const b = await bootstrap(process.cwd(), cfg.repoMapBudget);
        setConfig(cfg);
        setBundle(b);
        setStatus('idle');
      } catch (e) {
        setError((e as Error).message);
        setStatus('error');
      }
    })();
  }, []);

  useEffect(() => {
    if (status !== 'busy') {
      setElapsed(0);
      startedAtRef.current = null;
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      if (startedAtRef.current != null) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (pendingRef.current) {
        pendingRef.current.resolve(false);
        setPending(null);
      }
      if (statusRef.current === 'busy' && abortRef.current) {
        abortRef.current.abort();
      } else {
        exit();
      }
      return;
    }
    if (pendingRef.current) {
      if (input === 'y' || input === 'Y') {
        pendingRef.current.resolve(true);
        setPending(null);
      } else if (input === 'n' || input === 'N') {
        pendingRef.current.resolve(false);
        setPending(null);
      }
    }
  });

  const requestApproval = (req: ApprovalRequest): Promise<boolean> =>
    new Promise(resolve => setPending({ request: req, resolve }));

  const onSubmit = async (input: string) => {
    if (!config || !bundle || status !== 'idle') return;
    const trimmed = input.trim();
    if (!trimmed) return;
    setStatus('busy');
    setPhase('thinking');
    streamingRef.current = '';
    reasoningRef.current = '';
    setStreaming('');
    setStreamingReasoning('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runTurn({
        userInput: trimmed,
        history: messages.slice(),
        bundle,
        config,
        tools,
        payloads,
        signal: controller.signal,
        requestApproval: config.autoApprove ? undefined : requestApproval,
        onMessage: msg => {
          if (msg.role === 'assistant') {
            streamingRef.current = '';
            reasoningRef.current = '';
            setStreaming('');
            setStreamingReasoning('');
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
        onPhase: p => setPhase(p),
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
      streamingRef.current = '';
      reasoningRef.current = '';
      setStreaming('');
      setStreamingReasoning('');
      setStatus('idle');
      abortRef.current = null;
    }
  };

  const headerItems = useMemo<HeaderItem[]>(
    () => (bundle && config ? [{ model: config.model, cwd: bundle.cwd }] : []),
    [bundle, config],
  );

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text bold>Error</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Static items={headerItems}>
        {(h, i) => <Header key={i} model={h.model} cwd={h.cwd} />}
      </Static>
      {status === 'loading' ? (
        <Text>Loading…</Text>
      ) : (
        <>
          <Scrollback
            messages={messages}
            streaming={status === 'busy' ? streaming : ''}
            streamingReasoning={status === 'busy' ? streamingReasoning : ''}
          />
          {pending ? <Approval request={pending.request} /> : null}
          <Input
            disabled={status !== 'idle' || pending !== null}
            spinning={status === 'busy' && pending === null}
            onSubmit={onSubmit}
          />
          <Status
            model={config?.model ?? ''}
            turns={messages.filter(m => m.role === 'assistant').length}
            status={status === 'busy' ? phase : status}
            elapsed={status === 'busy' ? elapsed : null}
          />
        </>
      )}
    </Box>
  );
}
