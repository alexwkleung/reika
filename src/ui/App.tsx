import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Scrollback } from './Scrollback.js';
import { Input } from './Input.js';
import { Status } from './Status.js';
import { loadConfig } from '../config.js';
import { bootstrap } from '../context/bootstrap.js';
import { defaultTools } from '../tools/index.js';
import { PayloadStore } from '../store/payloads.js';
import { runTurn } from '../agent/loop.js';
import type { Config, ContextBundle, Message } from '../types.js';

type Phase = 'thinking' | 'tool';
type UIStatus = 'loading' | 'idle' | 'busy' | 'error';

export function App() {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<UIStatus>('loading');
  const [phase, setPhase] = useState<Phase>('thinking');
  const [streaming, setStreaming] = useState<string>('');
  const [config, setConfig] = useState<Config | null>(null);
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tools] = useState(() => defaultTools());
  const [payloads] = useState(() => new PayloadStore());
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<UIStatus>('loading');
  statusRef.current = status;

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const b = await bootstrap(process.cwd());
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
      if (statusRef.current === 'busy' && abortRef.current) {
        abortRef.current.abort();
      } else {
        exit();
      }
    }
  });

  const onSubmit = async (input: string) => {
    if (!config || !bundle || status !== 'idle') return;
    const trimmed = input.trim();
    if (!trimmed) return;
    setStatus('busy');
    setPhase('thinking');
    setStreaming('');
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
        onMessage: msg => {
          if (msg.role === 'assistant') setStreaming('');
          setMessages(prev => [...prev, msg]);
        },
        onContentDelta: delta => setStreaming(prev => prev + delta),
        onPhase: p => setPhase(p),
      });
      setStatus('idle');
      setStreaming('');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    } finally {
      abortRef.current = null;
    }
  };

  if (status === 'loading') return <Text>Loading…</Text>;
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
      <Scrollback messages={messages} streaming={status === 'busy' ? streaming : ''} />
      <Input disabled={status !== 'idle'} onSubmit={onSubmit} />
      <Status
        model={config?.model ?? ''}
        turns={messages.filter(m => m.role === 'assistant').length}
        status={status === 'busy' ? phase : status}
        elapsed={status === 'busy' ? elapsed : null}
        hint={status === 'busy' ? 'ctrl-c to abort' : null}
      />
    </Box>
  );
}
