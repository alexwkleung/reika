import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import {
  sandboxProfile,
  sandboxFooter,
  isBroadWorkdir,
  broadWorkdirNotice,
  networkAllowedFor,
  networkDecision,
  sandboxRefusedWrite,
  PREFIX_WORDS,
} from './_sandbox.js';

// The generator's string output, not the syscall — per AGENTS.md's "unit-test the logic the wrapper
// adds (caps, windows, footers — not the syscall)". Enforcement is verified by driving the real
// shell (see the issue's measured tables); what can be got wrong in code is the profile's ORDER, the
// network classifier and the footer's gating, so those are what these cover.

describe('sandboxProfile', () => {
  const profile = sandboxProfile({ network: false });

  it('denies writes wholesale, then re-allows only the workdir, temp and /dev', () => {
    const lines = profile.split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    expect(lines[2]).toBe('(deny file-write*)');
    expect(lines[3]).toBe('(allow file-write* (subpath (param "WORKDIR")))');
    // The git dir above cwd (monorepo package, worktree, submodule) — without it `git add` fails on
    // `.git/index.lock: Operation not permitted`, which reads as a stale lock.
    expect(lines[4]).toBe('(allow file-write* (subpath (param "GITDIR")))');
    // Temp by its REAL paths: `/tmp` is a symlink to `/private/tmp` and the kernel matches the
    // target, so `(subpath "/tmp")` would allow nothing. Denying temp made python's mkdtemp fall
    // through to cwd and write scratch into the project.
    expect(lines[5]).toBe('(allow file-write* (subpath "/private/tmp"))');
    expect(lines[6]).toBe('(allow file-write* (subpath "/private/var/tmp"))');
    expect(lines[7]).toBe('(allow file-write* (subpath (param "TMPDIR")))');
    // Caches: `go build` refuses to run at all without a writable ~/Library/Caches/go-build.
    expect(lines[8]).toBe('(allow file-write* (subpath (param "USERCACHE")))');
    expect(lines[9]).toBe('(allow file-write* (subpath (param "XDGCACHE")))');
    expect(lines[10]).toBe('(allow file-write* (subpath "/dev"))');
    expect(lines.filter(l => l.startsWith('(allow file-write*'))).toHaveLength(8);
  });

  // Seatbelt is last-match-wins, and this is the one ordering constraint that has a failure mode
  // worse than "a write is allowed": `/dev` is the PARENT of `/dev/null`, so anything placed after
  // it that is meant to win must be more specific than a whole directory — and a sibling path is
  // not. Getting this backwards silently re-allows `/dev/urandom`.
  it('puts the /dev allow last among the write rules', () => {
    const writeRules = profile.split('\n').filter(l => l.startsWith('(allow file-write*'));
    expect(writeRules[writeRules.length - 1]).toContain('/dev');
  });

  it('allows the workdir by param, never by interpolation', () => {
    // A cwd containing `"` or `)` would escape `(subpath "…")`. There must be no literal path.
    expect(profile).toContain('(param "WORKDIR")');
    expect(profile).toContain('(param "TMPDIR")');
    expect(profile).not.toMatch(/subpath "\/(?!dev|private\/(?:tmp|var\/tmp)")/);
  });

  // Both directions and every port: `(remote ip)` alone refused `network-bind`, so a test suite
  // starting a local server went red under the sandbox. Unix sockets are local IPC (docker, a local
  // DB, and macOS's DNS resolver), not the network.
  it('denies network, then re-allows loopback and unix sockets per operation', () => {
    const lines = profile.split('\n');
    const deny = lines.indexOf('(deny network*)');
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(lines.slice(deny + 1)).toEqual([
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote unix))',
      '(allow network-bind (local unix))',
      '(allow network-inbound (local unix))',
    ]);
    expect(profile).not.toContain('ALLOW_NET');
  });

  // The rule that has a measured hole behind it: `(allow network* (local ip "localhost:*"))` matched
  // every outbound connection — an unconnected socket has no local address yet — and `curl
  // http://1.1.1.1/` returned 301 through a profile whose comment said network was denied. A
  // `local` filter may only ever gate bind and inbound.
  it('never pairs a local filter with network* or network-outbound', () => {
    for (const line of profile.split('\n')) {
      if (/\(local /.test(line)) {
        expect(line, line).toMatch(/^\(allow network-(?:bind|inbound) \(local /);
      }
    }
  });

  it('drops the network rules entirely for a network-allowed command, keeping the write rules', () => {
    const net = sandboxProfile({ network: true });
    expect(net).not.toContain('network');
    expect(net.split('\n').slice(0, 11)).toEqual(profile.split('\n').slice(0, 11));
  });

  // Reads are deliberately open (#163 phase 5 is not built): `(allow default)` is what keeps grep,
  // glob and every test runner working without a filesystem enumeration that rots. If a read deny
  // is ever added here it must come with the carve-out list, so this asserts the decision.
  it('leaves reads open', () => {
    expect(profile).not.toContain('(deny file-read');
    expect(profile).toContain('(allow default)');
  });

  it('is a valid, complete expression set — balanced parens, one per line', () => {
    for (const p of [profile, sandboxProfile({ network: true })]) {
      expect(p.startsWith('(version 1)')).toBe(true);
      expect(p.split('\n').every(l => l.startsWith('(') && l.endsWith(')'))).toBe(true);
      const opens = (p.match(/\(/g) ?? []).length;
      const closes = (p.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

// The network half is per command: `gh`/`git`/`hf` reads keep it (the shipped skills open with the
// first two and the third downloads models the user names, and their mutating forms are flagged →
// prompted → unsandboxed anyway), everything else is denied past loopback. An allowlist — a wrong
// `false` costs a footer, a wrong `true` costs the guarantee.
describe('networkAllowedFor', () => {
  it('allows the unflagged gh/git reads the shipped skills open with', () => {
    expect(networkAllowedFor('gh pr view 436 --json title,body')).toBe(true);
    expect(networkAllowedFor('gh issue view 163 --json body')).toBe(true);
    expect(networkAllowedFor('git fetch origin && git log --oneline main..origin/main')).toBe(true);
    expect(networkAllowedFor('git ls-remote origin')).toBe(true);
    expect(networkAllowedFor('glab mr view 12')).toBe(true);
  });

  // The user's own words: "download this model" / "what's in that repo". `hf` is in NET_VERBS for
  // these, and _danger.ts holds it to HF_READ_VERBS so the mutating verbs cannot arrive unflagged —
  // which is what makes the allow safe to make (see the `hf` note on NET_VERBS).
  it('allows the unflagged hf reads a download or an inspection is made of', () => {
    expect(networkAllowedFor('hf download meta-llama/Llama-3.2-1B-Instruct')).toBe(true);
    expect(networkAllowedFor('hf download gpt2 --local-dir ./model 2>&1 | tail -20')).toBe(true);
    expect(networkAllowedFor('hf models info meta-llama/Llama-3.2-1B-Instruct')).toBe(true);
    expect(networkAllowedFor('hf datasets info HuggingFaceFW/fineweb')).toBe(true);
    expect(networkAllowedFor('hf spaces info user/space')).toBe(true);
  });

  // `HF_HUB_ENABLE_HF_TRANSFER=1 hf download …` is the documented speedup, so the prefix must not
  // cost the allow. A credential assigned inline does not keep it, the line `GH_TOKEN` sits on —
  // authentication does not need it (`hf` reads the saved token either way), and a token that is not
  // the saved one goes in by flag, `hf download --token …`, which keeps the allow.
  it('keeps the allow through a harmless hf env prefix, not a credential', () => {
    expect(networkAllowedFor('HF_HUB_ENABLE_HF_TRANSFER=1 hf download gpt2')).toBe(true);
    expect(networkAllowedFor('HF_HUB_DISABLE_PROGRESS_BARS=1 hf models ls --limit 10')).toBe(true);
    expect(networkAllowedFor('HF_TOKEN=hf_xxx hf download gpt2')).toBe(false);
    expect(networkAllowedFor('hf download --token hf_xxx gated/repo')).toBe(true);
  });

  it('keeps the allow through the inspection pipeline a model pages with', () => {
    expect(networkAllowedFor("gh pr diff 436 | sed -n '1,300p'")).toBe(true);
    expect(networkAllowedFor('gh pr diff 436 | wc -l')).toBe(true);
    expect(networkAllowedFor('gh pr diff 436 | grep -n "^+++" | head -20')).toBe(true);
    expect(networkAllowedFor('cd sub && git pull')).toBe(true);
  });

  // The `/review` skill's own line: xargs runs its argument command, so that is the verb read.
  it('reads through xargs to the command it runs', () => {
    expect(
      networkAllowedFor(
        "gh pr view 5 --json closingIssuesReferences --jq '.closingIssuesReferences[].number' | xargs -I{} gh issue view {} --json number,title",
      ),
    ).toBe(true);
    expect(
      networkAllowedFor('gh pr list --json number --jq ".[].number" | xargs -n 1 gh pr view'),
    ).toBe(true);
    expect(networkAllowedFor('echo x | xargs -I {} curl {}')).toBe(false);
  });

  // #621: the reads the shipped skills open with, in the clothes a model actually writes them in.
  // Sighted in this repo's session history — `timeout 120 gh pr view 620 --json …`, the wrapper a
  // model adds when GitHub is slow, and `sleep 5 && gh pr view 609 --json mergeable`, the poll that
  // wants the state GitHub has not finished computing — each ran with the network denied while the
  // bare read went through: the same read, blocked by its wrapper.
  it('reads the verb through a `timeout` carrier', () => {
    expect(networkAllowedFor('timeout 120 gh pr view 620 --json title,state')).toBe(true);
    expect(
      networkAllowedFor('cd /repo && timeout 120 gh pr view 620 --json body 2>&1 | tail -12'),
    ).toBe(true);
    expect(networkAllowedFor('timeout -k 5 30 gh issue view 1 --json body')).toBe(true);
    expect(networkAllowedFor('timeout --signal=KILL 30 git ls-remote origin')).toBe(true);
    // The carrier is not a way past the allow: what it bounds is still what gets read.
    expect(networkAllowedFor('timeout 30 curl https://x.example')).toBe(false);
    expect(networkAllowedFor("timeout 30 node -e 'fetch(1)'")).toBe(false);
    expect(networkDecision('timeout 30 npm test && gh pr view 1')).toEqual({
      allowed: false,
      blockedBy: 'npm',
    });
    // A carrier with nothing after it runs nothing, and is not a read.
    expect(networkAllowedFor('timeout 5')).toBe(false);
    expect(networkAllowedFor('timeout -k 5')).toBe(false);
  });

  it('keeps the allow through the wait a poll needs and the loop a multi-read needs', () => {
    expect(networkAllowedFor('sleep 5 && gh pr view 609 --json mergeable,mergeStateStatus')).toBe(
      true,
    );
    expect(networkAllowedFor('sleep 0.5; gh pr view 609 --json state')).toBe(true);
    // Still an allowlist: `sleep` alone is not a read, and it does not lend one to a sibling.
    expect(networkAllowedFor('sleep 5')).toBe(false);
    expect(networkAllowedFor('sleep 5 && npm test')).toBe(false);
    // The loop's head and `do`/`done` are grammar; the body's commands are each read on their own.
    expect(networkAllowedFor('for n in 610 608; do gh pr view $n --json title; done')).toBe(true);
    expect(networkAllowedFor('for n in 610 608; do\ngh pr view $n --json title\ndone')).toBe(true);
    expect(networkAllowedFor('for f in *; do rm -f $f; done')).toBe(false);
    expect(networkAllowedFor('for f in *; do curl https://x.example/$f; done')).toBe(false);
    // `while`'s condition is a command, and an unbounded poll is what the idle bound exists to kill.
    expect(networkAllowedFor('while true; do sleep 5; gh pr view 1; done')).toBe(false);
  });

  it('denies a pipeline with an unrecognized verb in it', () => {
    expect(
      networkAllowedFor('gh pr diff 436 | python3 -c "import sys; print(sys.stdin.read())"'),
    ).toBe(false);
    expect(networkAllowedFor('git fetch && npm install')).toBe(false);
    expect(networkAllowedFor('gh api /user; node -e "fetch(\'https://x.example\')"')).toBe(false);
  });

  it('denies the commands the deny exists for', () => {
    expect(networkAllowedFor('curl -s https://example.com')).toBe(false);
    expect(networkAllowedFor('ssh host "ps aux"')).toBe(false);
    expect(networkAllowedFor('python3 -c "import urllib.request"')).toBe(false);
    expect(networkAllowedFor('npm view left-pad version')).toBe(false);
    expect(networkAllowedFor('wget https://example.com')).toBe(false);
  });

  it('denies when a substitution could smuggle a second command', () => {
    expect(networkAllowedFor('gh pr view $(cat n.txt)')).toBe(false);
    expect(networkAllowedFor('git log `curl -s x`')).toBe(false);
    // Double quotes still execute a substitution, so this one is not data.
    expect(networkAllowedFor('gh pr view 1 --json body | sed -n "$(cat n)"')).toBe(false);
    expect(networkAllowedFor("gh pr view $(cat n.txt) | grep -c '```'")).toBe(false);
  });

  // Sighted: `gh pr view 609 --json body --jq .body | grep -c '```'` — reading a PR body for a
  // fenced block — was denied the network and blamed on `grep`. Inside single quotes the backtick
  // is a character the model is searching for, not a command; the same rule plan mode uses.
  it('keeps the allow when the substitution character is data', () => {
    expect(networkAllowedFor("gh pr view 609 --json body --jq .body | grep -c '```'")).toBe(true);
    expect(networkAllowedFor("gh pr view 1 --json body | grep -n '$(dirname'")).toBe(true);
    expect(networkAllowedFor("gh issue view 621 --json body | grep -c '`'")).toBe(true);
  });

  // A heredoc body is cut before the verb read (its prose runs nothing), but an UNQUOTED delimiter's
  // body is expanded by the shell when the line runs, so a `$(…)` in it executes on whatever network
  // the line's `git` verb was granted. The two shapes a model writes — `gh issue comment -F -` and
  // `git commit -F -` — are flagged, so they never reach this allow; `git apply -`/`--stdin` reads are
  // not, and those are what this pins.
  it('sees a substitution in a heredoc body the shell will expand', () => {
    expect(networkAllowedFor('git apply - <<EOF\n$(python3 -c "import urllib.request")\nEOF')).toBe(
      false,
    );
    expect(networkAllowedFor('git hash-object --stdin <<EOF\n`id`\nEOF')).toBe(false);
    expect(networkAllowedFor('git fetch && cat <<EOF\n$(id)\nEOF')).toBe(false);
    // A body is not quote-parsed, so an apostrophe in it must not mask a real substitution.
    expect(networkAllowedFor("git stripspace <<EOF\nit's $(id) don't\nEOF")).toBe(false);
    // A delimiter form the detector used to read as prose, and which `sh`, `bash`, `dash` and `zsh`
    // all open a heredoc for. The shells paste its body (the backslash quotes the delimiter), so the
    // deny here is the deliberate fail-closed read in `_heredoc.ts`: an apostrophe in the body must
    // not be what decides whether the `$(…)` between the apostrophes runs (#685).
    expect(networkAllowedFor("git hash-object --stdin <<\\EOF\nit's $(id) don't\nEOF")).toBe(false);
  });

  it('keeps the allow for a body that is literal, or carries nothing that runs', () => {
    // The `#163` case: a QUOTED delimiter pastes its body, expansion and all.
    expect(networkAllowedFor("git stripspace <<'EOF'\n$(id)\nEOF")).toBe(true);
    expect(
      networkAllowedFor(
        "gh issue comment 1 --body-file - <<'EOF'\nLooks good.\n\nOne question.\nEOF",
      ),
    ).toBe(true);
    // Unquoted, but nothing in the body runs: prose must not deny the line (that is why the body is
    // cut for the verb read in the first place).
    expect(networkAllowedFor('git fetch && cat <<EOF\nplain prose, no substitution\nEOF')).toBe(
      true,
    );
    expect(networkAllowedFor('git apply - <<EOF\n$(id) is \\$(not-expanded)\nEOF')).toBe(false);
    expect(networkAllowedFor('git apply - <<EOF\n\\$(id)\nEOF')).toBe(true);
    // The two newly-recognized delimiter forms, read the way their quoting says. `<<'A B'` pastes its
    // body, so a literal-looking `$(…)` in it is data. `<<\EOF` is deliberately read as expanding
    // (`_heredoc.ts`), so it keeps the allow here only because the body's `$` is escaped.
    expect(networkAllowedFor('git stripspace <<\\EOF\n\\$(id)\nEOF')).toBe(true);
    expect(networkAllowedFor("git stripspace <<'A B'\nit's literal $(id) here\nA B")).toBe(true);
  });

  it('is not fooled by a net verb in an argument or a quoted separator', () => {
    expect(networkAllowedFor('echo gh')).toBe(false);
    expect(networkAllowedFor('grep -rn "git fetch" src/')).toBe(false);
    expect(networkAllowedFor('cat "a;git fetch"')).toBe(false);
    expect(networkAllowedFor('')).toBe(false);
    expect(networkAllowedFor('cd sub')).toBe(false);
  });

  // `2>&1` contains `&`, which the segment splitter reads as a separator: the pipeline became a
  // segment whose verb was `1`, denied, and the footer sent the model to fetch_url for a PR.
  it('is not split by a stderr redirection', () => {
    expect(networkAllowedFor('gh pr view 436 2>&1 | head -50')).toBe(true);
    expect(networkAllowedFor('git fetch --all 2>&1')).toBe(true);
    expect(networkAllowedFor('gh pr diff 1 &> out.txt')).toBe(true);
    expect(networkAllowedFor('gh pr view 1 2>&1 | python3 -c "x"')).toBe(false);
  });

  // The inspection set minus what can run a command of its own: awk's program, find's exec family,
  // a git alias defined on the command line.
  it('denies the inspection commands that can shell out', () => {
    expect(networkAllowedFor('gh pr view 1 | awk \'{system("curl http://x")}\'')).toBe(false);
    expect(networkAllowedFor("git fetch; find . -name '*.sh' -exec sh {} \\;")).toBe(false);
    expect(networkAllowedFor("git fetch; find . -name '*.sh' -execdir sh {} \\;")).toBe(false);
    expect(networkAllowedFor("git -c alias.x='!curl http://x' x")).toBe(false);
    expect(networkAllowedFor("git fetch && find . -name '*.ts' | head")).toBe(true);
  });

  // `-c <key>=<value>` can name a program through more keys than are worth enumerating (sshCommand,
  // pager, credential.helper, hooksPath…), so it is refused wholesale; only fetch-shaped commands
  // need the allow, and none of them need `-c`. Same class through the environment.
  it('refuses git -c and program-naming env prefixes the allow', () => {
    expect(networkAllowedFor('git -c core.sshCommand=./x.sh fetch origin')).toBe(false);
    expect(networkAllowedFor('git -c core.pager=./x.sh log')).toBe(false);
    expect(networkAllowedFor('git -c core.pager=cat log -1')).toBe(false);
    expect(networkAllowedFor('git --config-env=core.sshCommand=X fetch')).toBe(false);
    expect(networkAllowedFor('GIT_SSH_COMMAND=./x.sh git fetch origin')).toBe(false);
    expect(networkAllowedFor('PAGER=./x.sh gh pr view 1')).toBe(false);
    expect(networkAllowedFor('GIT_PAGER=less git log')).toBe(false);
    expect(networkAllowedFor('GIT_EXEC_PATH=/tmp/x git fetch')).toBe(false);
    // The settings a model actually sets, none of which can name a program.
    expect(networkAllowedFor('GIT_TERMINAL_PROMPT=0 GH_PAGER= gh pr view 1')).toBe(true);
    expect(networkAllowedFor('PAGER=cat git log -1')).toBe(true);
    expect(networkAllowedFor('NO_COLOR=1 GH_NO_UPDATE_NOTIFIER=1 gh issue list')).toBe(true);
  });

  // Sighted in this repo's session history: `git ls-remote …; git grep -c '^<<<<<<<' FETCH_HEAD` ran
  // with the network denied, so the ls-remote failed with an ssh refusal the model read as a flaky
  // remote. The `-c` there is `git grep`'s count flag; only git's global prefix makes it a config
  // flag. The refusal above is unchanged — this is about where the flag sits, not whether it counts.
  it('reads -c as a config flag only in git’s global prefix, not an ordinary subcommand flag', () => {
    expect(
      networkAllowedFor("git ls-remote origin refs/heads/main; git grep -c '^<<<<<<<' FETCH_HEAD"),
    ).toBe(true);
    expect(networkAllowedFor('git grep -c TODO -- src | head -5')).toBe(true);
    expect(networkAllowedFor('git log -c -1')).toBe(true);
    expect(networkAllowedFor('git diff -c FETCH_HEAD HEAD')).toBe(true);
    expect(networkAllowedFor('git commit -c HEAD~1')).toBe(true);
    // A wrapper does not move the flag out of the prefix, and `-C <path>` takes a separate value.
    expect(networkAllowedFor('timeout 30 git -c core.sshCommand=./x.sh fetch origin')).toBe(false);
    expect(networkAllowedFor('git -C /repo -c core.pager=cat log')).toBe(false);
    expect(networkAllowedFor('git -C /repo log -1')).toBe(true);
    // A global option's VALUE word is not the subcommand either: git takes `--git-dir <path>` in the
    // space form, and the `-c` behind the value is still global (`git --git-dir <repo> -c
    // alias.z='!echo ZED' z` runs the aliased program). Skipping only `-C`'s value let that keep the
    // allow. The skip takes only a non-flag value, so `git -C -c k=v log` keeps scanning.
    expect(networkAllowedFor('git --git-dir /x -c core.sshCommand=./x.sh fetch origin')).toBe(
      false,
    );
    expect(networkAllowedFor('git --namespace /ns -c core.hooksPath=/x init')).toBe(false);
    expect(networkAllowedFor('git --work-tree /x -c core.pager=./x.sh log')).toBe(false);
    expect(networkAllowedFor('git --git-dir /x log -1')).toBe(true);
    expect(networkAllowedFor('git -C -c core.pager=cat log')).toBe(false);
    // A carrier's own words must not pose as the verb's: the `-I` placeholder below is not the git,
    // and the real one's `-c` is global.
    expect(networkAllowedFor('xargs -I git git -c core.sshCommand=./x.sh fetch')).toBe(false);
    expect(networkAllowedFor('xargs -I git git grep -c TODO')).toBe(true);
  });

  // The second, independent cause of that same call's refusal (#685), and the end-to-end shape: with
  // the `-c` half fixed by the test above the call still lost its allow, because a quoted `<<` in the
  // conflict-marker pattern made `maskSingleQuotedData` decline, and the raw fallback then read the
  // backtick inside single quotes further along the line as a substitution. Replayed over 5,920
  // recorded bash calls, this change moves exactly two verdicts: this shape and its own retry.
  it('keeps the allow for a compound whose quoted `<<` is a conflict-marker pattern', () => {
    const sighted =
      "cd /repo && echo '=== remote main ==='; git ls-remote origin refs/heads/main; " +
      "git show FETCH_HEAD:docs/configuration.md | grep -c 'optional `offset` reads from'; " +
      "git grep -c '^<<<<<<< \\|^>>>>>>> ' FETCH_HEAD -- docs src AGENTS.md | head -5; echo done";
    expect(networkAllowedFor(sighted)).toBe(true);
    expect(networkDecision(sighted)).toEqual({ allowed: true });
  });

  // The one subcommand whose own `-c` IS a config flag: `git clone -c/--config <key=value>` sets
  // config in the new repo before the remote fetch (`core.sshCommand`) and its hooks run at checkout
  // (`core.hooksPath`) — verified by planting a post-checkout through `git clone -c core.hooksPath`.
  // It keeps the refusal wherever it sits among clone's arguments; a plain clone keeps the allow
  // like any other fetch-shaped read.
  it('keeps the refusal for git clone’s own -c/--config, in any position', () => {
    expect(networkAllowedFor('git clone -c core.hooksPath=/x /repo /dst')).toBe(false);
    expect(networkAllowedFor('git clone --config core.sshCommand=./x.sh git@h:p.git d')).toBe(
      false,
    );
    expect(networkAllowedFor('git clone --config=k=v /repo /dst')).toBe(false);
    expect(networkAllowedFor('git clone /repo /dst -c k=v')).toBe(false);
    expect(networkAllowedFor('git clone --depth 1 /repo /dst')).toBe(true);
    expect(networkAllowedFor('git clone /repo /dst')).toBe(true);
  });

  // The global prefix is git's own parser, which takes exact spellings only, so it is read against an
  // allowlist: a value flag missing from a skip list hid every `-c` behind its value word (`git
  // --attr-source HEAD -c alias.z='!echo RAN' z` ran the alias, checked on git 2.50), and an
  // unrecognized flag now costs a false deny instead of a hole.
  it('refuses any git global flag it does not recognize', () => {
    expect(networkAllowedFor("git --attr-source HEAD -c alias.z='!curl x' z")).toBe(false);
    expect(networkAllowedFor('git --frobnicate x -c core.sshCommand=./x.sh fetch')).toBe(false);
    expect(networkAllowedFor('git --exec-path=/tmp/x fetch origin')).toBe(false);
    expect(networkAllowedFor('git -C./repo log')).toBe(false);
    expect(networkAllowedFor('git --attr-source HEAD log -1')).toBe(true);
    expect(networkAllowedFor('git --attr-source=HEAD log -1')).toBe(true);
    expect(networkAllowedFor('git --git-dir=/x --no-pager log -1')).toBe(true);
    expect(networkAllowedFor('git -P --no-optional-locks fetch origin')).toBe(true);
  });

  // Past the subcommand, what can name a program is enumerated — and matched the way parse-options
  // reads it: `--upl=cmd` ran as `--upload-pack` and `git clone -qu cmd` as `-u` (both checked on
  // git 2.50), so abbreviations and short bundles count, not only the spelling a model usually writes.
  it('refuses the git subcommand options that run a program', () => {
    expect(networkAllowedFor('git clone --template=/tmp/t https://h/r d')).toBe(false);
    expect(networkAllowedFor('git clone --templ /tmp/t https://h/r d')).toBe(false);
    expect(networkAllowedFor('git clone -u ./x.sh https://h/r d')).toBe(false);
    expect(networkAllowedFor('git clone -qu ./x.sh https://h/r d')).toBe(false);
    expect(networkAllowedFor("git fetch --upload-pack='curl x;git-upload-pack' origin")).toBe(
      false,
    );
    expect(networkAllowedFor("git ls-remote --upl='curl x' origin")).toBe(false);
    expect(networkAllowedFor('git push --receive-pack=./x.sh origin')).toBe(false);
    expect(networkAllowedFor("git rebase -x 'curl x' HEAD~1")).toBe(false);
    expect(networkAllowedFor("git rebase --exec='curl x' HEAD~1")).toBe(false);
    expect(networkAllowedFor("git grep -O'curl x' TODO")).toBe(false);
    expect(networkAllowedFor("git grep -nO 'curl x' TODO")).toBe(false);
    expect(networkAllowedFor("git difftool -x 'curl x'")).toBe(false);
    expect(networkAllowedFor("git submodule foreach 'curl x'")).toBe(false);
    expect(networkAllowedFor("git submodule --quiet foreach 'curl x'")).toBe(false);
    expect(networkAllowedFor("git bisect run 'curl x'")).toBe(false);
    expect(networkAllowedFor("git filter-branch --tree-filter 'curl x' HEAD")).toBe(false);
  });

  // The other direction: the same letters mean something else elsewhere, a value letter's value is
  // the rest of its bundle, `--no-config` only removes config, and after `--` everything is operands.
  it('keeps the allow for look-alike git options that run nothing', () => {
    expect(networkAllowedFor('git fetch -u origin main')).toBe(true);
    expect(networkAllowedFor('git grep -n -e TODO')).toBe(true);
    expect(networkAllowedFor('git clone -bcute https://h/r d')).toBe(true);
    expect(networkAllowedFor('git clone --no-config /repo d')).toBe(true);
    expect(networkAllowedFor('git clone /repo -- -c')).toBe(true);
    expect(networkAllowedFor('git grep -e x -- -O')).toBe(true);
    expect(networkAllowedFor('git submodule update --init')).toBe(true);
    expect(networkAllowedFor('git bisect log')).toBe(true);
    expect(networkAllowedFor('git switch -c topic origin/topic')).toBe(true);
  });

  // A heredoc body is data. Its lines split into segments whose "verb" was prose, and the standard
  // way a model writes a multi-line comment was denied every time.
  it('ignores heredoc bodies when reading verbs', () => {
    expect(
      networkAllowedFor(
        "gh issue comment 1 --body-file - <<'EOF'\nLooks good.\n\nOne question about the loop.\nEOF",
      ),
    ).toBe(true);
    expect(networkAllowedFor('gh pr comment 5 -F - <<EOF\nrm -rf everything\nEOF')).toBe(true);
    expect(networkAllowedFor('gh pr comment 5 -F - <<EOF\nbody\nEOF\ncurl http://x')).toBe(false);
  });

  // When a gh/git pipeline is denied because of a sibling, the verdict names it: the model's own
  // remedy is to run the git half by itself, and the footer says so instead of "ask the user".
  it('names the sibling command that cost a gh/git pipeline its allow', () => {
    expect(networkDecision('git fetch && npm test')).toEqual({ allowed: false, blockedBy: 'npm' });
    expect(networkDecision('gh pr diff 1 | python3 -c "x"')).toEqual({
      allowed: false,
      blockedBy: 'python3',
    });
    expect(networkDecision('gh pr view 1')).toEqual({ allowed: true });
    // No gh/git at all: nothing to name, and no remedy of that shape.
    expect(networkDecision('npm test')).toEqual({ allowed: false });
  });

  it('sees through env assignments and wrappers to the verb', () => {
    expect(networkAllowedFor('GH_PAGER= gh pr view 1')).toBe(true);
    expect(networkAllowedFor('GIT_TERMINAL_PROMPT=0 git fetch --all')).toBe(true);
    expect(networkAllowedFor('time git clone https://example.com/r.git')).toBe(true);
    expect(networkAllowedFor('sudo git fetch')).toBe(true);
  });

  // The env check reads past the same wrappers the verb reader strips: stopping at `env` found no
  // assignment and gave `env GIT_SSH_COMMAND=./x.sh git fetch` the allow its bare spelling is refused.
  it('checks env assignments behind a wrapper as well as bare ones', () => {
    expect(networkAllowedFor('env GIT_SSH_COMMAND=./x.sh git fetch')).toBe(false);
    expect(networkAllowedFor('sudo GIT_SSH_COMMAND=./x.sh git fetch')).toBe(false);
    expect(networkAllowedFor('command env PAGER=./x.sh gh pr view 1')).toBe(false);
    expect(networkAllowedFor('env GIT_TERMINAL_PROMPT=0 git fetch')).toBe(true);
    for (const w of PREFIX_WORDS) {
      expect(networkAllowedFor(`${w} GIT_SSH_COMMAND=./x.sh git fetch`)).toBe(false);
    }
  });

  // `args` is the verb's own words after its carrier is dropped, so find's exec scan has to see
  // through `timeout` and `xargs` like the verb does.
  it('sees find -exec through a carrier', () => {
    expect(networkAllowedFor("git fetch && timeout 5 find . -exec curl x '{}' +")).toBe(false);
    expect(networkAllowedFor("git ls-files | xargs find -exec curl x '{}' +")).toBe(false);
    expect(networkAllowedFor('git fetch && timeout 5 find . -name x')).toBe(true);
  });
});

describe('isBroadWorkdir', () => {
  // The two halves of the profile degrade independently, so a broad cwd is sandboxed and *said* —
  // the case that is genuinely void is the filesystem root, which is a different check entirely.
  it('flags home, the filesystem root and the root of a volume', () => {
    expect(isBroadWorkdir('/Users/someone', '/Users/someone')).toBe(true);
    expect(isBroadWorkdir('/', '/Users/someone')).toBe(true);
    expect(isBroadWorkdir('/Volumes/Backup', '/Users/someone')).toBe(true);
    expect(isBroadWorkdir('/Volumes/Backup/', '/Users/someone')).toBe(true);
  });

  // A project that happens to live on a second drive is an ordinary cwd; telling its owner "most of
  // your files" are exposed would be false.
  it('does not flag an ordinary project, on the boot volume or another', () => {
    expect(isBroadWorkdir('/Users/someone/Git/repo', '/Users/someone')).toBe(false);
    expect(isBroadWorkdir('/tmp/x', '/Users/someone')).toBe(false);
    expect(isBroadWorkdir('/Volumes/SSD/code/proj', '/Users/someone')).toBe(false);
  });

  it('names what is and is not covered, with the home path abbreviated', () => {
    const notice = broadWorkdirNotice('/Users/someone', '/Users/someone');
    expect(notice).toContain('(~)');
    expect(notice).toContain('/etc');
    expect(notice).not.toContain('/Users/someone');
  });
});

describe('sandboxFooter', () => {
  const denied = { network: false };
  const curlDns = 'curl: (6) Could not resolve host: example.com\n';
  const curlConnect =
    "curl: (7) Failed to connect to example.com port 443 after 5 ms: Couldn't connect to server\n";

  it('stays silent on success and on a signal death', () => {
    expect(sandboxFooter('curl https://x.example', 0, curlDns, denied)).toBe('');
    expect(sandboxFooter('curl https://x.example', null, curlDns, denied)).toBe('');
  });

  // The gate is the point, and it is on the OUTPUT: a gate on the command's name fired on every red
  // `npm test`, every `cargo test` failure and `git diff --exit-code`'s exit 1, blaming the sandbox
  // for genuine failures — the exact misattribution the footer exists to prevent.
  it('stays silent for a failure the sandbox had nothing to do with', () => {
    expect(sandboxFooter('npx vitest run src/foo.test.ts', 1, 'FAIL 3 tests\n', denied)).toBe('');
    expect(sandboxFooter('grep -rn useThing src/', 1, '', denied)).toBe('');
    expect(sandboxFooter('node -e "process.exit(1)"', 1, '', denied)).toBe('');
    expect(sandboxFooter('npm test', 1, 'AssertionError: expected 1 to be 2\n', denied)).toBe('');
    expect(sandboxFooter('git diff --exit-code', 1, 'diff --git a/x b/x\n', denied)).toBe('');
    expect(sandboxFooter('cargo test', 101, 'test result: FAILED. 1 failed\n', denied)).toBe('');
  });

  it('explains the network misattribution when the output carries a denial', () => {
    for (const out of [curlDns, curlConnect]) {
      const footer = sandboxFooter('curl https://example.com', 7, out, denied);
      expect(footer).toContain('sandbox');
      expect(footer).toContain('Network access is denied');
      expect(footer).toContain('fetch_url');
    }
  });

  // `curl -s` prints nothing and exits 6: the exit status is the only signal, so it carries it.
  it('catches a silent curl by its exit status', () => {
    expect(sandboxFooter('curl -s -m 3 https://example.com', 6, '', denied)).toContain(
      'Network access is denied',
    );
    expect(sandboxFooter('curl -s http://10.0.0.1/', 7, '', denied)).toContain(
      'Network access is denied',
    );
    // Any other status is curl's own complaint about the request, not a denial.
    expect(sandboxFooter('curl -f https://example.com/404', 22, '', denied)).toBe('');
  });

  // Measured under the profile: the denial texts each client actually prints. DNS answers (a unix
  // socket), so the denial lands on connect(); the resolver shapes stay for a machine whose DNS goes
  // another way. git and npm report a credentials problem and a proxy problem respectively, so the
  // footer pre-empts both.
  it('recognises each client’s denial text', () => {
    const cases: Array<[string, number, string]> = [
      [
        'git push origin main',
        128,
        "fatal: unable to access 'https://…': Failed to connect to github.com port 443 after 20 ms: Couldn't connect to server\n",
      ],
      [
        'git push origin main',
        128,
        "fatal: unable to access 'https://…': Could not resolve host: github.com\n",
      ],
      [
        'git ls-remote origin',
        128,
        'ssh: connect to host github.com port 22: Operation not permitted\n',
      ],
      ['npm install', 1, 'npm error code EPERM\nnpm error syscall connect\n'],
      ['npm install', 1, 'npm error code ENOTFOUND\nnpm error syscall getaddrinfo\n'],
      ['node fetch.js', 1, 'Error: connect EPERM 93.184.216.34:443\n'],
      [
        'python3 fetch.py',
        1,
        'urllib.error.URLError: <urlopen error [Errno 1] Operation not permitted>\n',
      ],
      [
        'python3 fetch.py',
        1,
        'URLError: <urlopen error [Errno 8] nodename nor servname provided, or not known>\n',
      ],
      ['go get example.com/m', 1, 'dial tcp: lookup proxy.golang.org: no such host\n'],
      ['pip install x', 1, 'Temporary failure in name resolution\n'],
    ];
    for (const [cmd, code, out] of cases) {
      expect(sandboxFooter(cmd, code, out, denied), cmd).toContain('auth/proxy');
    }
  });

  // Minimal mode is bash alone and an offline session registers neither web tool: naming fetch_url
  // there is the phantom pointer #377 is about. `curl` is what the model reaches for in that mode.
  it('does not point at fetch_url or search when the turn does not offer them', () => {
    const minimal = sandboxFooter('curl -s https://example.com', 6, '', {
      network: false,
      toolNames: new Set(['bash', 'ask_user']),
    });
    expect(minimal).toContain('Network access is denied');
    expect(minimal).not.toContain('fetch_url');
    expect(minimal).not.toContain('search tool');
    expect(minimal).toContain('ask the user');
    const fetchOnly = sandboxFooter('curl -s https://example.com', 6, '', {
      network: false,
      toolNames: new Set(['bash', 'fetch_url']),
    });
    expect(fetchOnly).toContain('fetch_url');
    expect(fetchOnly).not.toContain('search tool');
  });

  // A command that ran WITH network (a `gh` read) cannot have been denied it, so a DNS error there is
  // the machine's, not the sandbox's — no footer, or it would send the model to fetch_url for
  // something fetch_url cannot do either.
  it('never blames a network-allowed run for a network error', () => {
    expect(
      sandboxFooter('gh pr view 1', 1, 'error connecting to api.github.com\n', { network: true }),
    ).toBe('');
    expect(
      sandboxFooter('git fetch', 128, 'Could not resolve host: github.com\n', { network: true }),
    ).toBe('');
  });

  // Measured: `ps`/`top` cannot be exec'd under seatbelt at all, even under a bare `(allow default)`
  // profile, so allowlisting them is not an option and the footer is the only fix — keyed on the
  // shell's own refusal line, so it does not depend on the command also looking like a network
  // client, and cannot fire on `docker ps` or `grep ps` either.
  it('names ps/top as unrunnable rather than letting it read as a broken pipeline', () => {
    const footer = sandboxFooter(
      'ps aux | grep node',
      1,
      '/bin/sh: /bin/ps: Operation not permitted\n',
      denied,
    );
    expect(footer).toContain('ps');
    expect(footer).toContain('cannot be run under the local sandbox');
    expect(
      sandboxFooter('top -l 1', 126, '/bin/sh: /usr/bin/top: Operation not permitted\n', denied),
    ).toContain('cannot be run under the local sandbox');
  });

  // Filesystem denials name the path, so they get one line: it is the sandbox, not something sudo
  // fixes. Keyed on a PATH before the colon, which is what tells the shape from the network ones.
  it('names a refused write for what it is, without the network advice', () => {
    for (const out of [
      '/bin/sh: /Users/someone/notes.md: Operation not permitted\n',
      'mkdir: /Users/someone/x: Operation not permitted\n',
      "Error: EPERM: operation not permitted, mkdir '/Users/someone/x'\n",
      'go: failed to initialize build cache at /Users/someone/.cargo/x: mkdir /Users/someone/.cargo/x: operation not permitted\n',
      // Python's write denial carries the same Errno 1 the network one does; the quoted path is
      // what tells them apart, and it must not collect the fetch_url advice.
      "PermissionError: [Errno 1] Operation not permitted: '/Users/someone/out.txt'\n",
    ]) {
      const footer = sandboxFooter('go build ./...', 1, out, denied);
      expect(footer, out).toContain('refused by the sandbox');
      expect(footer, out).not.toContain('Network access is denied');
      expect(sandboxRefusedWrite(out), out).toBe(true);
    }
    expect(sandboxRefusedWrite('/bin/sh: /bin/ps: Operation not permitted\n')).toBe(false);
    expect(sandboxRefusedWrite('ssh: connect to host x port 22: Operation not permitted\n')).toBe(
      false,
    );
    expect(
      sandboxRefusedWrite(
        'urllib.error.URLError: <urlopen error [Errno 1] Operation not permitted>\n',
      ),
    ).toBe(false);
  });

  // `mkdir ~/x; echo ok` exits 0 with the denial in its output. The write note is on the shape
  // alone; the ps and network notes keep the exit gate, since a red run is when they are read.
  it('reports a refused write even when the command exited 0', () => {
    const out = 'mkdir: /Users/someone/x: Operation not permitted\nok\n';
    expect(sandboxFooter('mkdir ~/x; echo ok', 0, out, denied)).toContain('refused by the sandbox');
    expect(sandboxFooter('curl -s x; echo done', 0, curlConnect, denied)).toBe('');
  });

  it('names the sibling that cost a gh/git pipeline its network, with the remedy', () => {
    const footer = sandboxFooter('git fetch && npm test', 1, curlConnect, denied);
    expect(footer).toContain('`npm`');
    expect(footer).toContain('own bash call');
    expect(footer).not.toContain('ask the user');
  });

  it('does not mistake ps in an argument for the ps command', () => {
    expect(sandboxFooter('docker ps', 1, 'Cannot connect to the Docker daemon\n', denied)).toBe('');
    expect(sandboxFooter('grep -c ps file', 1, '', denied)).toBe('');
    expect(sandboxFooter('npx tailwindcss --help', 1, '', denied)).toBe('');
    expect(sandboxFooter('ls options/', 1, '', denied)).toBe('');
  });
});

// dirname('x') === 'x' is what identifies a filesystem root, and it is the one check that decides
// "do not start at all" rather than "start and say so".
describe('filesystem root detection', () => {
  it('is the dirname-is-itself test', () => {
    expect(dirname('/')).toBe('/');
    expect(dirname('/Users/someone')).toBe('/Users');
  });
});
