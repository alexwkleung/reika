import { expandMentions } from './mentions.js';
import {
  attachImageBlocks,
  readNativeAttachments,
  type ImageAttachment,
  type NativeImage,
  type NativeImageBytes,
} from './attachments.js';
import { expandPastedUrls, planPastedUrls } from './pastedurls.js';
import { matchSkill, shouldConfirmInject, type SkillMatch } from '../skills/skillmatch.js';
import { imageReader, pasteIsNative } from '../ocr/select.js';
import { expandPastes, type PastedText } from '../ui/pastes.js';
import type { Skill } from '../skills/skills.js';
import type { Config, Mode, PasteFetchMode, SkillAutoMode } from '../types.js';

// What a typed prompt becomes before it reaches the model (#584): which questions to ask first, and
// the model-facing text. The TUI and headless each kept a copy of this and a third front end would
// have needed another. A front end owns how a question is asked and where a notice is drawn; what
// is asked, in what order the text is built, and what each notice says live here.

// The skill to ask about before sending (#425), or null. Chat has no bash for a skill's first step.
export function skillToConfirm(
  prompt: string,
  ctx: { skills: Skill[]; skillAuto: SkillAutoMode; mode: Mode; contextWindow?: number },
): SkillMatch | null {
  if (ctx.skillAuto === 'off' || prompt.startsWith('/')) return null;
  if (ctx.mode === 'shell' || ctx.mode === 'chat') return null;
  const match = matchSkill(prompt, ctx.skills);
  return match && shouldConfirmInject(match, ctx.contextWindow) ? match : null;
}

// The links to ask about before fetching (#448), or null: ones the prompt is not about.
export function urlsToConfirm(
  prompt: string,
  ctx: { pasteFetch: PasteFetchMode; mode: Mode },
): string[] | null {
  if (ctx.pasteFetch === 'off' || prompt.startsWith('/') || ctx.mode === 'shell') return null;
  const plan = planPastedUrls(prompt);
  return plan.urls.length === 0 || plan.request ? null : plan.urls;
}

// A wait worth narrating: the submit blocks on these, and an unlabelled one reads as a dead Enter.
export type SubmitStage =
  | { kind: 'describe-image'; model: string }
  | { kind: 'fetch-urls'; count: number };

export function submitStageLabel(stage: SubmitStage): string {
  if (stage.kind === 'describe-image') return `Describing image with ${stage.model}`;
  return `Fetching ${stage.count} pasted link${stage.count > 1 ? 's' : ''}`;
}

export type SubmitNotice = { content: string; tone: 'info' | 'warn' };

export type SubmitInputOptions = {
  cwd: string;
  skills: Skill[];
  // Resolved onto the active profile: it picks the image reader and says whether the model sees.
  config: Config;
  // The skill confirm's answer: a name to apply, null for declined, undefined when nobody asked.
  skillRoute?: string | null;
  // Skills already suggested this session, updated here. Absent, an unapplied match says nothing.
  skillHints?: Set<string>;
  // The pasted-link confirm's answer; undefined when nobody was asked.
  fetchUrls?: boolean;
  images?: ImageAttachment[];
  pastes?: PastedText[];
  onStage?: (stage: SubmitStage) => void;
};

export type SubmitInput = {
  modelText: string;
  // What the user bubble shows: the prompt with its markers and mentions unexpanded.
  display: string;
  skill?: string;
  nativeImages?: NativeImage[];
  // Receipts for the scrollback, in the order the steps ran. Never part of the model's context.
  notices: SubmitNotice[];
};

// Every step but the last reads `prompt`, the user's own words: a URL or a trigger phrase inside an
// @mention'd file or a paste is content, not a request.
export async function buildSubmitInput(
  prompt: string,
  opts: SubmitInputOptions,
): Promise<SubmitInput> {
  const notices: SubmitNotice[] = [];
  const reader = imageReader(opts.config);
  const vision = opts.config.visionModel;
  const ocr: typeof reader = vision
    ? bytes => {
        opts.onStage?.({ kind: 'describe-image', model: vision });
        return reader(bytes);
      }
    : reader;
  const expansion = await expandMentions(prompt, opts.cwd, { ocr });
  notices.push(...expansion.notices.map(content => ({ content, tone: 'warn' as const })));
  const urls = await expandPastedUrls(prompt, {
    mode: opts.config.pasteFetch,
    incidental: opts.fetchUrls,
    onStart: count => opts.onStage?.({ kind: 'fetch-urls', count }),
  });
  notices.push(...urls.notices.map(n => ({ content: n.text, tone: n.tone })));

  // An image pasted under a profile that could see, sent on one that cannot, is read first.
  let images = opts.images ?? [];
  if (!pasteIsNative(opts.config) && images.some(a => a.native)) {
    const read = await readNativeAttachments(images, ocr);
    images = read.attachments;
    for (const marker of read.failed) {
      notices.push({
        content: `Couldn't read ${marker} for ${opts.config.model}, which can't see images — it was pasted under a profile that could.`,
        tone: 'warn',
      });
    }
  }
  let modelText = attachImageBlocks(expansion.augmented, images);
  // attachImageBlocks' liveness rule: a marker the user deleted sends neither text nor bytes.
  const nativeImages = images
    .filter((a): a is ImageAttachment & { native: NativeImageBytes } =>
      Boolean(a.native && modelText.includes(a.marker)),
    )
    .map((a): NativeImage => ({ marker: a.marker, ...a.native }));
  if (urls.blocks.length > 0) modelText = `${urls.blocks.join('\n\n')}\n\n${modelText}`;

  let skill: string | undefined;
  const match = matchSkill(prompt, opts.skills);
  if (match && opts.skillRoute === match.skill.name) {
    // Says what happened, not just that something matched: the body is in the prompt (#398).
    notices.push({
      content: `Skill /${match.skill.name} applied — its body was prepended to this prompt (matched: ${match.matched.join(', ')}).`,
      tone: 'info',
    });
    skill = match.skill.name;
    modelText = `${match.skill.body}\n\n${modelText}`;
  } else if (match && opts.skillHints && !opts.skillHints.has(match.skill.name)) {
    opts.skillHints.add(match.skill.name);
    // A decline at the dialog was the hint; a line repeating it right after is the nag.
    if (opts.skillRoute !== null) {
      notices.push({
        content: `Skill hint: /${match.skill.name} — ${match.skill.description}. Prompt sent unchanged; start with /${match.skill.name} to apply it.`,
        tone: 'info',
      });
    }
  }
  // Last, so a paste marker stood in for its text through every match above.
  modelText = expandPastes(modelText, opts.pastes ?? []);
  return {
    modelText,
    display: expansion.display,
    ...(skill ? { skill } : {}),
    ...(nativeImages.length > 0 ? { nativeImages } : {}),
    notices,
  };
}
