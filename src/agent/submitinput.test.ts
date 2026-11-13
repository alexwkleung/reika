import { describe, expect, it } from 'vitest';
import {
  buildSubmitInput,
  skillToConfirm,
  submitStageLabel,
  urlsToConfirm,
  type SubmitInputOptions,
} from './submitinput.js';
import type { ImageAttachment } from './attachments.js';
import type { Config } from '../types.js';

const verify = {
  name: 'verify',
  description: 'verify a change',
  body: 'VERIFY BODY',
  source: 'project' as const,
  path: '/skills/verify.md',
  triggers: ['verify the change'],
};

const config = { pasteFetch: 'off', skillAuto: 'ask', model: 'test-model' } as unknown as Config;

const opts = (over: Partial<SubmitInputOptions> = {}): SubmitInputOptions => ({
  cwd: process.cwd(),
  skills: [verify],
  config,
  ...over,
});

describe('skillToConfirm', () => {
  const ctx = { skills: [verify], skillAuto: 'ask' as const, mode: 'agent' as const };

  it('asks about a prompt that opens with a trigger', () => {
    expect(skillToConfirm('verify the change please', ctx)?.skill.name).toBe('verify');
  });

  it('asks in plan mode too', () => {
    expect(skillToConfirm('verify the change', { ...ctx, mode: 'plan' })).not.toBeNull();
  });

  it('does not ask in chat or shell, for a slash command, or with routing off', () => {
    expect(skillToConfirm('verify the change', { ...ctx, mode: 'chat' })).toBeNull();
    expect(skillToConfirm('verify the change', { ...ctx, mode: 'shell' })).toBeNull();
    expect(skillToConfirm('/verify the change', ctx)).toBeNull();
    expect(skillToConfirm('verify the change', { ...ctx, skillAuto: 'off' })).toBeNull();
  });

  it('does not ask when the trigger is only mentioned mid-sentence', () => {
    expect(skillToConfirm('the docs say to verify the change twice', ctx)).toBeNull();
  });
});

describe('urlsToConfirm', () => {
  const ctx = { pasteFetch: 'ask' as const, mode: 'agent' as const };
  const incidental = 'the build failed\nError: see https://example.com/docs for details\nexit 1';

  it('asks about a link the prompt is not about', () => {
    expect(urlsToConfirm(incidental, ctx)).toEqual(['https://example.com/docs']);
  });

  it('does not ask when the link is the request', () => {
    expect(urlsToConfirm('summarize https://example.com/docs', ctx)).toBeNull();
  });

  it('does not ask in shell mode, for a slash command, or with fetching off', () => {
    expect(urlsToConfirm(incidental, { ...ctx, mode: 'shell' })).toBeNull();
    expect(urlsToConfirm(`/review ${incidental}`, ctx)).toBeNull();
    expect(urlsToConfirm(incidental, { ...ctx, pasteFetch: 'off' })).toBeNull();
  });
});

describe('buildSubmitInput', () => {
  it('passes a plain prompt through unchanged', async () => {
    const out = await buildSubmitInput('what does this do', opts({ skills: [] }));
    expect(out).toEqual({
      modelText: 'what does this do',
      display: 'what does this do',
      notices: [],
    });
  });

  it('prepends the skill body when the route names the matched skill', async () => {
    const out = await buildSubmitInput('verify the change', opts({ skillRoute: 'verify' }));
    expect(out.modelText).toBe('VERIFY BODY\n\nverify the change');
    expect(out.skill).toBe('verify');
    expect(out.notices).toEqual([
      {
        content:
          'Skill /verify applied — its body was prepended to this prompt (matched: verify the change).',
        tone: 'info',
      },
    ]);
  });

  it('hints once per skill per session when nobody was asked', async () => {
    const skillHints = new Set<string>();
    const first = await buildSubmitInput('verify the change', opts({ skillHints }));
    expect(first.modelText).toBe('verify the change');
    expect(first.skill).toBeUndefined();
    expect(first.notices[0]?.content).toMatch(/^Skill hint: \/verify — verify a change\./);
    const second = await buildSubmitInput('verify the change', opts({ skillHints }));
    expect(second.notices).toEqual([]);
  });

  it('says nothing after a decline, then or later', async () => {
    const skillHints = new Set<string>();
    const declined = await buildSubmitInput(
      'verify the change',
      opts({ skillRoute: null, skillHints }),
    );
    expect(declined.modelText).toBe('verify the change');
    expect(declined.notices).toEqual([]);
    const later = await buildSubmitInput('verify the change', opts({ skillHints }));
    expect(later.notices).toEqual([]);
  });

  it('says nothing about an unapplied match without a hint set', async () => {
    const out = await buildSubmitInput('verify the change', opts());
    expect(out.notices).toEqual([]);
  });

  it('expands a paste marker last, so its text is never matched as a trigger', async () => {
    const pastes = [{ marker: '[Pasted text #1 +3 lines]', text: 'verify the change\nnow' }];
    const out = await buildSubmitInput(
      'look at [Pasted text #1 +3 lines]',
      opts({ pastes, skillHints: new Set() }),
    );
    expect(out.modelText).toBe('look at verify the change\nnow');
    expect(out.display).toBe('look at [Pasted text #1 +3 lines]');
    expect(out.notices).toEqual([]);
  });

  it('attaches a read image whose marker is still in the prompt, and drops a deleted one', async () => {
    const images: ImageAttachment[] = [
      { marker: '[Image 1]', text: 'first shot', source: 'clipboard' },
      { marker: '[Image 2]', text: 'second shot', source: 'clipboard' },
    ];
    const out = await buildSubmitInput('what is in [Image 2]', opts({ images }));
    expect(out.modelText).toContain('second shot');
    expect(out.modelText).not.toContain('first shot');
    expect(out.modelText.endsWith('what is in [Image 2]')).toBe(true);
    expect(out.nativeImages).toBeUndefined();
  });

  it('hands native bytes through on a profile that can see', async () => {
    const native = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' };
    const images = [
      { marker: '[Image 1]', text: 'note', source: 'clipboard', native },
    ] as unknown as ImageAttachment[];
    const out = await buildSubmitInput(
      'describe [Image 1]',
      opts({ images, config: { ...config, vision: 'native' } as Config }),
    );
    expect(out.nativeImages).toEqual([{ marker: '[Image 1]', ...native }]);
  });
});

describe('submitStageLabel', () => {
  it('words each stage', () => {
    expect(submitStageLabel({ kind: 'describe-image', model: 'vis' })).toBe(
      'Describing image with vis',
    );
    expect(submitStageLabel({ kind: 'fetch-urls', count: 1 })).toBe('Fetching 1 pasted link');
    expect(submitStageLabel({ kind: 'fetch-urls', count: 2 })).toBe('Fetching 2 pasted links');
  });
});
