import { describe, expect, it } from 'vitest';
import { isReadOnlyShell } from './_readonly.js';

describe('isReadOnlyShell', () => {
  // The read-only escapes actually observed in real loops — these must stay classifiable.
  it.each([
    'grep -n "isFavorite\\|toggleFavorite" web/src/scripts/state.ts | head -20',
    'cd /home/dev/example-app && grep -n "btn-favorite" web/src/components/NowPlaying.astro',
    'cd /home/dev/example-app && cat web/src/scripts/state.ts | tail -20',
    'grep -A 5 "favorite-btn" web/src/scripts/dom.ts | head -20',
    'cat web/src/components/NowPlaying.astro | grep -A 5 "btn-favorite"',
    'grep -n "repair-btn" web/src/scripts/dom.ts',
    'ls web/src/scripts',
    'find web/src -name "*.ts"',
    'wc -l web/src/scripts/dom.ts',
  ])('classifies read-only inspection as read-only: %s', cmd => {
    expect(isReadOnlyShell(cmd)).toBe(true);
  });

  it.each([
    'npm run build',
    'git commit -m "favorites"',
    'mkdir -p web/src/scripts',
    'rm -rf dist',
    'cd web && npm test',
    'grep foo file.ts && rm file.ts', // read-only THEN a mutator in the chain
    'grep foo file | node script.js',
    'curl example.com | grep foo',
  ])('classifies mutating/build commands as NOT read-only: %s', cmd => {
    expect(isReadOnlyShell(cmd)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a cd hop leaving no inspection command', 'cd web/src'],
  ])('returns false for %s', (_label, cmd) => {
    expect(isReadOnlyShell(cmd)).toBe(false);
  });

  // Below: one case per escape the classifier claims to close. A wrong `true` here is a write that
  // plan mode admitted, so each enumerated rule earns its own test rather than riding on the prose.
  describe('command substitution runs a command the allowlist never sees', () => {
    it.each([
      'echo $(rm -rf dist)',
      'echo `rm -rf dist`',
      'cat <(rm -rf dist)',
      'echo "$(rm -rf dist)"', // still executes inside double quotes
      'echo $((1+1))', // arithmetic is harmless; denied anyway, safety over precision
    ])('rejects %s', cmd => {
      expect(isReadOnlyShell(cmd)).toBe(false);
    });
  });

  describe('redirection is a write, unless it is search-pattern data', () => {
    it.each([
      'grep foo bar > out.txt',
      'cat a.ts > b.ts',
      'ls >> log',
      'npm run build 2>&1 | head',
    ])('rejects %s', cmd => {
      expect(isReadOnlyShell(cmd)).toBe(false);
    });

    it('allows a redirection character that is quoted search data', () => {
      expect(isReadOnlyShell('grep ">" file.txt')).toBe(true);
      expect(isReadOnlyShell('cat "; rm -rf /"')).toBe(true); // a file with an alarming name
    });
  });

  describe('every separator starts a new command', () => {
    it.each([
      ['semicolon', 'cat f; rm -rf dist'],
      ['background', 'cat f & rm -rf dist'],
      ['pipe', 'cat f | rm -rf dist'],
      ['and', 'cat f && rm -rf dist'],
      ['or', 'cat f || rm -rf dist'],
      ['newline', 'cat f\nrm -rf dist'],
      ['carriage return', 'cat f\r\nrm -rf dist'],
      ['no surrounding whitespace', 'cat f;rm -rf dist'],
    ])('splits on %s', (_label, cmd) => {
      expect(isReadOnlyShell(cmd)).toBe(false);
    });

    it('does not split on a separator inside quotes', () => {
      expect(isReadOnlyShell("echo 'a;b'")).toBe(true);
    });

    it('rejects a command hidden behind an unbalanced quote', () => {
      expect(isReadOnlyShell('cat "; rm -rf /')).toBe(false);
    });
  });

  describe('commands that interpret a program argument are not allowlisted', () => {
    it.each([
      `awk 'BEGIN{print "x" > "/tmp/pwn"}'`, // writes from inside the quoted program
      `awk 'BEGIN{system("rm -rf dist")}'`,
      `awk '{print $2}' file`, // read-only in practice, still not provable
      `sed 's/a/b/w /tmp/pwn' file`, // the w flag writes
      `sed -i "s/x/y/" file.ts`,
      `sed --in-place s/x/y/ file.ts`,
      `sed -n '1,50p' file`,
      'tree src', // -o writes the listing to a file
    ])('rejects %s', cmd => {
      expect(isReadOnlyShell(cmd)).toBe(false);
    });
  });

  describe('find: the write-and-exec flags', () => {
    it.each([
      'find . -name "*.tmp" -delete',
      'find . -name "*.ts" -exec rm {} \;',
      'find . -execdir rm {} +',
      'find . -ok rm {} \;',
      'find . -okdir rm {} \;',
      'find . -fprint /tmp/pwn',
      'find . -fprintf /tmp/pwn "%p"',
      'find . -fls /tmp/pwn',
      "find . '-delete'", // quoting a flag does not stop it being one
      'find . "-delete"',
    ])('rejects %s', cmd => {
      expect(isReadOnlyShell(cmd)).toBe(false);
    });

    it('allows -printf, which only writes to stdout', () => {
      expect(isReadOnlyShell('find . -name "*.ts" -printf "%p\\n"')).toBe(true);
    });
  });

  describe('sort: -o writes a file', () => {
    it.each(['sort -o out.txt in.txt', 'sort --output=out.txt in.txt', 'sort -no out.txt in.txt'])(
      'rejects %s',
      cmd => {
        expect(isReadOnlyShell(cmd)).toBe(false);
      },
    );

    it('allows sort flags that only read', () => {
      expect(isReadOnlyShell('sort -n file | head')).toBe(true);
    });
  });

  describe('uniq: the second operand is an output file', () => {
    it('rejects a second operand', () => {
      expect(isReadOnlyShell('uniq in.txt out.txt')).toBe(false);
    });

    it.each(['sort f | uniq -c', 'uniq -c in.txt'])('allows %s', cmd => {
      expect(isReadOnlyShell(cmd)).toBe(true);
    });
  });

  // `-i` used to read as an in-place-edit signal, which denied the single most common grep flag.
  // It existed for `sed -i`, and sed is no longer allowlisted.
  it('allows case-insensitive grep', () => {
    expect(isReadOnlyShell('grep -i foo file.ts')).toBe(true);
  });
});
