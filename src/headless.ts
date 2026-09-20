import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, resolveDefaultMode, resolveProfile, withProbedWindow } from './config.js';
import { probeContextWindow } from './provider/contextwindow.js';
import { bootstrap } from './context/bootstrap.js';
import { chatTools, defaultTools, minimalTools, planTools } from './tools/index.js';
import { isOffline } from './tools/_net.js';
import { PayloadStore } from './store/payloads.js';
import { saveTranscript, TRANSCRIPT_VERSION } from './store/transcript.js';
import { runTurn } from './agent/loop.js';
import { expandMentions } from './agent/mentions.js';
import { expandPastedUrls } from './agent/pastedurls.js';
import { matchSkill, shouldAutoInject } from './skillmatch.js';
import { systemOcr } from './ocr/system.js';
import { autoApproves } from './approval.js';
import { debugLog } from './debug.js';
import { HEADLESS_USAGE, type HeadlessArgs, type HeadlessMode } from './headlessargs.js';
import { detectIdentity, setIdentity } from './ui/identity.js';
import {
  buildImplementPrompt,
  isMinimalPrompt,
  planWritten,
  turnPromptMode,
  turnTools,
} from './ui/commands.js';
import type { ApprovalRequest, Config, ContextBundle, Message, Tool, Usage } from './types.js';

// Headless mode (#52): `reika -p "<prompt>"` runs one turn with no TUI and prints the reply.
// The loop was never coupled to Ink — evals/runner.ts has driven it headless all along — so this
// is the eval runner's boot plus the pieces of App's submit path that shape what the model sees
// (mention/URL expansion, skill routing, the approval policy). Those are deliberately the same
// modules App calls, in the same order: a headless run must be the run the TUI would have made,
// or it is useless as the debugging instrument the issue asks for.

export type HeadlessIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
};

// The model-facing text for a prompt, built the way App's submit path builds it: a leading
// /<skill> is that skill's body (with the rest as extra guidance), otherwise @mentions and pasted
// URLs expand and a `triggers:` match may auto-inject. Returns the notices those steps produced
// so the caller can surface them; they never enter the model's context here either.
export async function buildHeadlessInput(
  prompt: string,
  config: Config,
  bundle: ContextBundle,
  mode: HeadlessMode,
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
  const expansion = await expandMentions(prompt, bundle.cwd, { ocr: systemOcr(config.ocrLangs) });
  notices.push(...expansion.notices);
  const urls = await expandPastedUrls(prompt, { enabled: config.pasteFetch });
  notices.push(...urls.notices.map(n => n.text));
  let modelText = expansion.augmented;
  if (urls.blocks.length > 0) modelText = `${urls.blocks.join('\n\n')}\n\n${modelText}`;
  // Same exclusion as App.routeSkill: a skill body landing in plan mode competes with the plan
  // prompt. Headless has no one to suggest it to, so a non-injecting match is silent — and no one
  // to ask, so only 'apply' injects; the interactive default 'ask' sends the prompt as typed.
  const match = matchSkill(prompt, bundle.skills);
  const auto =
    match &&
    config.skillAuto === 'apply' &&
    (mode === 'agent' || mode === 'vibe') &&
    shouldAutoInject(match, config.contextWindow);
  if (match && auto) {
    notices.push(
      `Skill /${match.skill.name} applied — its body was prepended to this prompt (matched: ${match.matched.join(', ')}).`,
    );
    return { modelText: `${match.skill.body}\n\n${modelText}`, skill: match.skill.name, notices };
  }
  return { modelText, notices };
}

export async function runHeadless(args: HeadlessArgs, io: HeadlessIo): Promise<number> {
  if (args.help) {
    io.stdout(`${HEADLESS_USAGE}\n`);
    return 0;
  }
  const prompt = (args.prompt ?? (await io.readStdin())).trim();
  if (!prompt) {
    io.stderr('reika: no prompt given\n');
    return 1;
  }

  let cfg = loadConfig();
  const [bundle, probed] = await Promise.all([
    bootstrap(process.cwd(), cfg.repoMapBudget),
    cfg.profiles.default.contextWindow == null
      ? probeContextWindow(cfg.profiles.default)
      : Promise.resolve(undefined),
    cfg.anon
      ? detectIdentity(process.cwd())
          .then(setIdentity)
          .catch(() => {})
      : Promise.resolve(),
  ]);
  if (probed?.window) cfg = withProbedWindow(cfg, 'default', probed.window);
  const config = resolveProfile(cfg, 'default');
  const offline = isOffline();
  if (offline) io.stderr('reika: no network — search and fetch_url are off for this run\n');
  // No one is at the keyboard, so ask_user is never offered — a model that can see it will call
  // it and stall. The loop reads canAsk from the list, so the prompt agrees.
  const noAsk = (tools: Tool[]): Tool[] => tools.filter(t => t.name !== 'ask_user');
  const lists = {
    agent: noAsk(defaultTools(cfg, { offline })),
    plan: noAsk(planTools()),
    chat: noAsk(chatTools(cfg, { offline })),
    minimal: noAsk(minimalTools()),
  };
  const mode: HeadlessMode = args.mode ?? resolveDefaultMode();
  const input = await buildHeadlessInput(prompt, config, bundle, mode);
  for (const n of input.notices) io.stderr(`reika: ${n}\n`);

  const requestApproval =
    config.autoApprove === 'bypass'
      ? undefined
      : (req: ApprovalRequest): Promise<boolean> => {
          if (autoApproves(config.autoApprove, req)) return Promise.resolve(true);
          io.stderr(
            `reika: declined ${req.tool} (no prompt to ask at): ${firstLine(req.preview)}\n`,
          );
          return Promise.resolve(false);
        };

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  const history: Message[] = [];
  const appended: Message[] = [];
  const payloads = new PayloadStore();
  const totals: Usage = { promptTokens: 0, completionTokens: 0 };
  // Boxed: TS narrows a `let` assigned only inside a callback to its initializer.
  const usage: { last?: Usage } = {};
  let calibration: number | undefined;
  let prefillRate: number | undefined;
  let shrink = { sheds: 0, folds: 0 };

  const turn = (modelText: string, active: HeadlessMode, skill?: string): Promise<void> =>
    runTurn({
      userInput: modelText,
      userDisplay: modelText === input.modelText ? prompt : undefined,
      userSkill: skill,
      history,
      bundle,
      config,
      tools: turnTools(active, lists),
      payloads,
      signal: controller.signal,
      requestApproval,
      promptMode: turnPromptMode(active),
      minimalPrompt: isMinimalPrompt(active),
      onMessage: raw => {
        const msg: Message = raw.role === 'user' ? { ...raw, mode } : raw;
        appended.push(msg);
        // The persistent receipts App puts in the scrollback — a fold, a declined URL, the
        // typecheck gate bouncing the model — are the ones a human watching a pipe should see.
        if (msg.role === 'system') io.stderr(`reika: ${msg.content}\n`);
      },
      onUsage: u => {
        usage.last = u;
        totals.promptTokens += u.promptTokens;
        totals.completionTokens += u.completionTokens;
        if (u.cachedTokens != null)
          totals.cachedTokens = (totals.cachedTokens ?? 0) + u.cachedTokens;
      },
      priorShrink: shrink,
      onShrink: (_event, counts) => {
        shrink = counts;
      },
      priorCalibration: calibration,
      onCalibration: f => {
        calibration = f;
      },
      priorPrefillRate: prefillRate,
      onPrefillRate: r => {
        prefillRate = r;
      },
    });

  let failed: Error | null = null;
  try {
    if (mode === 'vibe') {
      // The same chain App.runVibeTurn runs: a plan turn, then the implement prompt as an agent
      // turn only when the plan phase actually wrote a plan.
      await turn(input.modelText, 'plan', input.skill);
      if (planWritten(appended)) {
        await turn(buildImplementPrompt(''), 'agent');
      } else {
        io.stderr(
          'reika: vibe: the plan phase ended without a written plan — skipping implementation\n',
        );
      }
    } else {
      await turn(input.modelText, mode, input.skill);
    }
  } catch (e) {
    failed = e as Error;
  } finally {
    process.off('SIGINT', onSigint);
  }

  if (args.save) {
    try {
      const { jsonlPath } = await saveTranscript(
        join(homedir(), '.config', 'reika', 'history'),
        appended,
        {
          version: TRANSCRIPT_VERSION,
          savedAt: new Date().toISOString(),
          model: config.model,
          baseURL: config.baseURL,
          cwd: bundle.cwd,
          messageCount: appended.length,
          mode,
          usage: {
            turns: appended.filter(m => m.role === 'assistant').length,
            ...totals,
            contextTokens: usage.last?.promptTokens ?? null,
            ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
            ...(shrink.sheds > 0 || shrink.folds > 0 ? shrink : {}),
          },
        },
      );
      io.stderr(`reika: saved ${appended.length} messages → ${jsonlPath}\n`);
    } catch (e) {
      io.stderr(`reika: save failed: ${(e as Error).message}\n`);
    }
  }

  if (failed) {
    debugLog(`headless: turn failed: ${failed.message}`);
    io.stderr(`reika: ${failed.message}\n`);
    return controller.signal.aborted ? 130 : 1;
  }
  if (args.json) {
    io.stdout(`${JSON.stringify(appended)}\n`);
  }
  // An interrupted turn commits an `(aborted)` assistant message so the history reads right; on
  // a pipe that is not a reply, and the exit status already says what happened.
  if (controller.signal.aborted) {
    io.stderr('reika: interrupted\n');
    return 130;
  }
  const reply = finalReply(appended);
  if (!args.json && reply) io.stdout(`${reply}\n`);
  return reply ? 0 : 1;
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
