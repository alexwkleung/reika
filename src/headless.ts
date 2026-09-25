import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, resolveDefaultMode } from './config.js';
import { saveTranscript, TRANSCRIPT_VERSION } from './store/transcript.js';
import { createSession } from './session.js';
import { expandMentions } from './agent/mentions.js';
import { expandPastedUrls } from './agent/pastedurls.js';
import { matchSkill, shouldAutoInject } from './skillmatch.js';
import { imageReader } from './ocr/select.js';
import { autoApproves } from './approval.js';
import { debugLog } from './debug.js';
import type { HeadlessArgs, HeadlessMode } from './headlessargs.js';

import type { ApprovalRequest, Config, ContextBundle, Message } from './types.js';

// Headless mode (#52): `reika -p "<prompt>"` runs one turn with no TUI and prints the reply.
// The session (boot, threaded state, the vibe chain) is session.ts, shared with the eval runner;
// what lives here is the part of App's submit path that shapes what the model sees (mention/URL
// expansion, skill routing) and the approval policy. Those are deliberately the same modules App
// calls, in the same order: a headless run must be the run the TUI would have made, or it is
// useless as the debugging instrument the issue asks for.

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
  const expansion = await expandMentions(prompt, bundle.cwd, { ocr: imageReader(config) });
  notices.push(...expansion.notices);
  // No `incidental`: there is nobody to ask, so a link the prompt is not about is left alone
  // under 'ask' and fetched under 'apply' — the REIKA_SKILL_AUTO split.
  const urls = await expandPastedUrls(prompt, { mode: config.pasteFetch });
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
  const prompt = (args.prompt ?? (await io.readStdin())).trim();
  if (!prompt) {
    io.stderr('reika: no prompt given\n');
    return 1;
  }

  // autoApprove is session-wide, not per-profile, so the loaded config decides the policy.
  const loaded = loadConfig();
  const session = await createSession({
    cwd: process.cwd(),
    config: loaded,
    canAsk: false,
    requestApproval:
      loaded.autoApprove === 'bypass'
        ? undefined
        : (req: ApprovalRequest): Promise<boolean> => {
            if (autoApproves(loaded.autoApprove, req)) return Promise.resolve(true);
            io.stderr(
              `reika: declined ${req.tool} (no prompt to ask at): ${firstLine(req.preview)}\n`,
            );
            return Promise.resolve(false);
          },
    events: {
      // The persistent receipts App puts in the scrollback — a fold, a declined URL, the
      // typecheck gate bouncing the model — are the ones a human watching a pipe should see.
      onMessage: msg => {
        if (msg.role === 'system') io.stderr(`reika: ${msg.content}\n`);
      },
    },
  });
  const { config, bundle } = session;
  if (session.limitsNotice) io.stderr(`reika: ${session.limitsNotice}\n`);
  if (session.offline) io.stderr('reika: no network — search and fetch_url are off for this run\n');
  const mode: HeadlessMode = args.mode ?? resolveDefaultMode();
  const input = await buildHeadlessInput(prompt, config, bundle, mode);
  for (const n of input.notices) io.stderr(`reika: ${n}\n`);

  const controller = new AbortController();
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
  }
  const appended = session.transcript;

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
            ...session.totals,
            contextTokens: session.lastUsage?.promptTokens ?? null,
            ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
            ...(session.shrink.sheds > 0 || session.shrink.folds > 0 ? session.shrink : {}),
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
