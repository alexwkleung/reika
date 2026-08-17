import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import {
  authorEmails,
  clearIdentity,
  isAnon,
  ownerSlugs,
  scrubIdentity,
  setIdentity,
} from './identity.js';
import { scrubDisplay } from './scrub.js';

afterEach(() => clearIdentity());

describe('scrubIdentity', () => {
  it('is a no-op until an identity is loaded', () => {
    expect(scrubIdentity('octocat pushed to main')).toBe('octocat pushed to main');
  });

  it('substitutes the git author line that `git log` prints', () => {
    setIdentity({ names: ['octocat', 'Mona Lisa'], emails: ['octocat25@example.com'] });
    expect(scrubIdentity('Author: Mona Lisa <octocat25@example.com>')).toBe(
      'Author: <user> <<email>>',
    );
  });

  // The email CONTAINS the name token, so name-first ordering would leave `<user>25@example.com`.
  it('consumes the whole email before the name inside it', () => {
    setIdentity({ names: ['octocat'], emails: ['octocat25@example.com'] });
    expect(scrubIdentity('octocat25@example.com')).toBe('<email>');
  });

  // "Mona Lisa" must be consumed before the bare "Mona" can eat half of it.
  it('prefers the longest matching name', () => {
    setIdentity({ names: ['Mona', 'Mona Lisa'], emails: [] });
    expect(scrubIdentity('Mona Lisa')).toBe('<user>');
  });

  it('substitutes an account slug in a remote URL but leaves third parties alone', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    const out = scrubIdentity(
      'https://github.com/octocat/hello-world vs https://github.com/anthropics/claude-code',
    );
    expect(out).toContain('github.com/<user>/hello-world');
    expect(out).toContain('github.com/anthropics/claude-code');
  });

  it('leaves a third-party HF org untouched', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    expect(scrubIdentity('Qwen/Qwen3-30B-A3B')).toBe('Qwen/Qwen3-30B-A3B');
  });

  // The over-scrub failure mode: a name token eating a longer word that contains it. (Uses a
  // token long enough to qualify for bare-word matching at all — see the delimited-only suite.)
  it('anchors on word boundaries so a name is not matched inside a longer word', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    expect(scrubIdentity('octocatalog and octocat')).toBe('octocatalog and <user>');
  });

  it('drops tokens too short to be identifiers', () => {
    setIdentity({ names: ['Oc'], emails: [] });
    expect(scrubIdentity('Ocarina done, Oc')).toBe('Ocarina done, Oc');
  });

  it('does not half-scrub a longer token that starts with the name', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    expect(scrubIdentity('octocat25')).toBe('octocat25');
  });

  it('escapes regex metacharacters in a name', () => {
    setIdentity({ names: ['mona.lisa'], emails: [] });
    expect(scrubIdentity('monaXlisa and mona.lisa')).toBe('monaXlisa and <user>');
  });
});

// Plenty of real account names are also ordinary words or code identifiers. Word-boundary
// matching wrecked those: a user named `max` saw `Math.max(a, b)` render as `Math.<user>(a, b)`.
// Short single-word tokens now match only where they sit as a real path/slug segment.
describe('short single-word tokens (delimited-only matching)', () => {
  it('leaves a short token alone in code and prose', () => {
    setIdentity({ names: ['max'], emails: [] });
    expect(scrubIdentity('const n = Math.max(a, b);')).toBe('const n = Math.max(a, b);');
    expect(scrubIdentity('maxTokens: 4096,')).toBe('maxTokens: 4096,');
  });

  // The two positions the lookahead/prefix set had to exclude by hand.
  it('does not fire on a single dash or at start-of-line', () => {
    setIdentity({ names: ['dev'], emails: [] });
    expect(scrubIdentity('dev-build here')).toBe('dev-build here');
    setIdentity({ names: ['mark'], emails: [] });
    expect(scrubIdentity('mark the spot')).toBe('mark the spot');
  });

  it('still substitutes a short token in a path segment', () => {
    setIdentity({ names: ['max'], emails: [] });
    expect(scrubIdentity('/Volumes/x/max/p')).toBe('/Volumes/x/<user>/p');
  });

  it('still substitutes a short token in a remote URL', () => {
    setIdentity({ names: ['max'], emails: [] });
    expect(scrubIdentity('https://github.com/max/repo')).toBe('https://github.com/<user>/repo');
  });

  it('still substitutes a short token in a HuggingFace cache directory', () => {
    setIdentity({ names: ['max'], emails: [] });
    expect(scrubIdentity('~/.cache/hub/models--max--q4')).toBe('~/.cache/hub/models--<user>--q4');
  });

  it('keeps the bare-word match for a long handle', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    expect(scrubIdentity('octocat opened issue #5')).toBe('<user> opened issue #5');
  });

  // A two-word phrase effectively cannot collide, so length does not gate it.
  it('keeps the bare-word match for a short multi-word name', () => {
    setIdentity({ names: ['Ada L'], emails: [] });
    expect(scrubIdentity('Author: Ada L')).toBe('Author: <user>');
  });
});

describe('anon toggle state', () => {
  it('reports off until enabled, and on once an identity is set', () => {
    expect(isAnon()).toBe(false);
    setIdentity({ names: ['octocat'], emails: [] });
    expect(isAnon()).toBe(true);
    clearIdentity();
    expect(isAnon()).toBe(false);
  });

  // The distinction `rules.length` can't make: on-but-found-nothing is not the same as off, and
  // the /anon receipt has to tell those apart.
  it('reports on even when detection found nothing to substitute', () => {
    setIdentity({ names: [], emails: [] });
    expect(isAnon()).toBe(true);
    expect(scrubIdentity('octocat')).toBe('octocat');
  });

  it('stops substituting once cleared', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    expect(scrubIdentity('octocat')).toBe('<user>');
    clearIdentity();
    expect(scrubIdentity('octocat')).toBe('octocat');
  });
});

describe('ownerSlugs', () => {
  it('pulls the account out of both remote URL forms', () => {
    const remotes = [
      'origin\tgit@github.com:octocat/hello-world.git (fetch)',
      'origin\thttps://github.com/octocat/hello-world.git (push)',
      'hf\thttps://huggingface.co/octocat/my-quant (fetch)',
    ].join('\n');
    expect(new Set(ownerSlugs(remotes))).toEqual(new Set(['octocat']));
  });

  it('ignores hosts where the first segment is not an account', () => {
    expect(ownerSlugs('origin\thttps://git.example.com/scm/proj/repo.git (fetch)')).toEqual([]);
  });
});

describe('authorEmails', () => {
  // NUL-separated, matching the `--format=%an%x00%ae` the detector asks git for — a name can
  // contain spaces, so a space separator would split "Mona Lisa" in the wrong place.
  const LOG = [
    'Mona Lisa\0octocat@example.com',
    'Mona Lisa\0mona.old@example.net',
    'Some Contributor\0them@elsewhere.example',
  ].join('\n');

  // The gap this exists for: an address `git config user.email` has never heard of, because it
  // was configured on a different machine or a decade ago.
  it('picks up historical addresses for a known author', () => {
    expect(authorEmails(LOG, ['Mona Lisa'])).toEqual([
      'octocat@example.com',
      'mona.old@example.net',
    ]);
  });

  // A shared repo is full of other people's addresses; scrubbing those would be plain wrong.
  it('ignores other contributors', () => {
    expect(authorEmails(LOG, ['Mona Lisa'])).not.toContain('them@elsewhere.example');
  });

  it('yields nothing when no name is known', () => {
    expect(authorEmails(LOG, [])).toEqual([]);
  });
});

// The layer order in scrubDisplay is load-bearing; these are the two ways it can break.
describe('scrubDisplay layer order', () => {
  it('still collapses $HOME when the username is also an identity token', () => {
    // Derived from the real $HOME rather than hardcoded, so this asserts the ordering rather
    // than this machine's layout. The last segment of $HOME is the username on every platform
    // reika runs on, and it is the token that makes the two layers collide.
    const home = homedir();
    const username = home.split('/').filter(Boolean).pop() ?? '';
    if (username.length < 3) return; // token would be dropped as too short; nothing to assert
    setIdentity({ names: [username], emails: [] });
    // Identity-first would rewrite this to /home/<user>/x, and the $HOME literal would then
    // never match — paths would silently stop collapsing to ~.
    expect(scrubDisplay(`${home}/x/y.ts`, '/nowhere')).toBe('~/x/y.ts');
  });

  it('still redacts a key-anchored secret when the value is an identity token', () => {
    setIdentity({ names: ['octocat'], emails: ['octocat25@example.com'] });
    // Identity-first would rewrite the value out from under the `appleId=` anchor.
    expect(scrubDisplay('appleId=octocat25@example.com', '/nowhere')).toBe('appleId=<redacted>');
  });
});
