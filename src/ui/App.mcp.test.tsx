import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { glyphs } from './glyphs.js';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';
import type * as ManagerModule from '../mcp/manager.js';

// The TUI half of MCP (#265): a server configured in the session is announced at startup, listed by
// /mcp, and callable as `/<server>:<tool>` — which is the whole point of exposing the tools as
// commands, so it is asserted where the user reads it: the rendered frame.
const MINI_SERVER = [
  "const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let b='';",
  "process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;",
  "while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);",
  "if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'mini-server',version:'1.0'}}});",
  "else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[",
  "{name:'ping',description:'Ping the server.',inputSchema:{type:'object',properties:{}}},",
  "{name:'echo',description:'Echo text.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}});",
  "else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:m.params.name==='ping'?'pong':'echo: '+m.params.arguments.text}]}});else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});}});",
].join('');

const CONFIG: Config = {
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
  model: 'test-model',
  models: ['test-model'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'off',
  subagentMaxTurns: 5,
  profiles: {
    default: { model: 'test-model', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' },
  },
  minGenTokens: 512,
  reasoningRounds: 1,
  maxSearchesPerTurn: 3,
  maxFetchesPerTurn: 3,
  bashTimeoutMs: 1000,
  bashIdleMs: 1000,
  pasteFetch: 'off',
  skillAuto: 'off',
  anon: false,
  sandbox: false,
  mcpServers: [{ name: 'mini', command: process.execPath, args: ['-e', MINI_SERVER] }],
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/tmp/app-mcp-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => CONFIG, resolveDefaultMode: () => 'agent' };
});
vi.mock('../context/bootstrap.js', async importActual => ({
  ...(await importActual<object>()),
  bootstrap: async () => BUNDLE,
}));
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => ({}), saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));
vi.mock('../agent/loop.js', () => ({ runTurn: async () => {} }));

// The MCP handshake is the whole of what the pre-session frame waits on, so holding it open is what
// lets the "says what it is waiting for" test below see that frame. Everything else stays real.
let mcpDelayMs = 0;
vi.mock('../mcp/manager.js', async () => {
  const actual = await vi.importActual<typeof ManagerModule>('../mcp/manager.js');
  return {
    ...actual,
    connectMcpServers: async (servers: Parameters<typeof actual.connectMcpServers>[0]) => {
      if (mcpDelayMs > 0) await new Promise(r => setTimeout(r, mcpDelayMs));
      return actual.connectMcpServers(servers);
    },
  };
});

const { App } = await import('./App.js');

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

function inputLine(app: { lastFrame: () => string | undefined }): string {
  const rows = plain(app.lastFrame())
    .split('\n')
    .filter(l => l.includes('│') && l.includes('> '));
  return rows[rows.length - 1] ?? '';
}

async function submit(
  app: { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined },
  text: string,
) {
  for (let i = 0; i < 200 && !inputLine(app).includes(text); i++) {
    app.stdin.write(text);
    await tick(20);
  }
  if (!inputLine(app).includes(text)) throw new Error(`input never echoed: ${text}`);
  app.stdin.write('\r');
  await tick(120);
}

/** Wait for a string to appear in the frame, so a spawned server's latency is not the test's. */
async function waitFor(
  app: { lastFrame: () => string | undefined },
  text: string,
): Promise<string> {
  for (let i = 0; i < 100 && !plain(app.lastFrame()).includes(text); i++) await tick(25);
  const frame = plain(app.lastFrame());
  expect(frame).toContain(text);
  return frame;
}

describe('MCP in the TUI', () => {
  // #265: the handshake is the one leg of bootstrap that can hold the first frame for seconds, so
  // that frame names what it is waiting on instead of sitting blank. It says nothing once the
  // servers are up — the announcement below is the standing record.
  it('names the servers it is starting while bootstrap waits on them, and then stops', async () => {
    mcpDelayMs = 400;
    try {
      const app = render(<App />);
      for (let i = 0; i < 12 && !plain(app.lastFrame()).includes('Starting MCP'); i++)
        await tick(25);
      expect(plain(app.lastFrame())).toContain('Starting MCP: mini…');

      const frame = await waitFor(app, 'MCP: mini (2 tools)');
      expect(frame).toContain(`${glyphs.notice} MCP: mini (2 tools)`);
      expect(frame).not.toContain('Starting MCP');
      app.unmount();
    } finally {
      mcpDelayMs = 0;
    }
  });

  it('announces a configured server at startup and lists its commands under /mcp', async () => {
    const app = await mountApp();
    await waitFor(app, 'MCP: mini (2 tools) — 2 tools added in agent mode. /mcp lists them.');

    await submit(app, '/mcp');
    const frame = await waitFor(app, '/mini:echo');
    expect(frame).toContain('MCP: 1 server, 2 tools');
    expect(frame).toContain('mini — 2 tools (mini-server 1.0, MCP 2025-06-18)');
    expect(frame).toContain('/mini:ping');
    app.unmount();
  });

  it('calls a tool from its slash command, with JSON or a bare string argument', async () => {
    const app = await mountApp();
    await waitFor(app, 'MCP: mini (2 tools)');

    await submit(app, '/mini:ping');
    let frame = await waitFor(app, 'pong');
    expect(frame).toContain('mcp mini:ping — 4 chars');

    await submit(app, '/mini:echo {"text":"hi"}');
    frame = await waitFor(app, 'echo: hi');
    expect(frame).toContain('mcp mini:echo — 8 chars');

    // A bare string is the single declared argument.
    await submit(app, '/mini:echo bye');
    await waitFor(app, 'echo: bye');
    app.unmount();
  });

  it('explains a bad argument list instead of calling the server', async () => {
    const app = await mountApp();
    await waitFor(app, 'MCP: mini (2 tools)');

    await submit(app, '/mini:echo {"text":');
    const frame = await waitFor(app, 'not valid JSON');
    // The tool was not called: no result line for it anywhere in the frame.
    expect(frame).not.toContain('mcp mini:echo —');
    app.unmount();
  });

  // A document that did not parse is the case where *nothing* started, so it is worth the warning
  // glyph rather than the quiet info line a healthy launch gets — keying on the failure wording
  // instead missed this one, because it names no server (#265 review). The tone is the glyph.
  it('warns about a config error, and leaves a healthy launch on the info glyph', async () => {
    CONFIG.mcpErrors = ['REIKA_MCP_SERVERS: invalid JSON: unexpected token'];
    try {
      const app = await mountApp();
      const frame = await waitFor(app, 'REIKA_MCP_SERVERS: invalid JSON: unexpected token');
      expect(frame).toContain(`${glyphs.noticeWarn} REIKA_MCP_SERVERS: invalid JSON`);
      expect(frame).toContain(`${glyphs.notice} MCP: mini (2 tools)`);
      app.unmount();
    } finally {
      delete CONFIG.mcpErrors;
    }
  });
});
