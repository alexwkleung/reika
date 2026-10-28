// The words that sit between a segment's start and the command it actually runs: privilege and
// environment wrappers (`sudo -u me`, `env -i`), the two carriers that only bound or reprioritize a
// command (`timeout 5`, `nice -n 10`), and `command`/`nohup`/`exec`/`time`.
//
// One table, because two readers ask the same question about it and answered differently (#756).
// `_danger.ts`'s `stripVerbPrefix` puts the verb in verb position for the `^`-anchored approval
// patterns, where missing one costs a fetch that runs unprompted under `safe`: `timeout 5 curl x`
// read as a `timeout` line and reported nothing. `_readonly.ts`'s `dropCarriers` skips the carrier
// for plan mode's read-only gate and the sandbox's network reader, where a carrier it does not know
// is a read it refuses. A spelling only one of them learns is a hole in whichever it is not
// (#749/#752 were that drift, one level down), so the table is the single place a carrier is
// described, and both walks below are its only readers.
//
// Nothing here is a shell lexer: the walkers take the words their caller already produced —
// `_danger.ts`'s quote-aware `SHELL_WORD_RE` walk, `_readonly.ts`'s `words()`.

export interface Carrier {
  /** Options that consume the NEXT word as their value, short and long spellings alike. */
  values: readonly string[];
  /** Non-option words the carrier takes before the command it runs (`timeout`'s DURATION). */
  operands: number;
  /**
   * The command behind it runs with the same effect, only bounded (`timeout`) or deprioritized
   * (`nice`), so a reader can skip the carrier and go on asking its own question about that
   * command. `sudo`/`env` hand it a different environment and `nohup` writes `nohup.out`, so they
   * are words the verb reader strips and nothing more: `sudo rm -rf` must never read as a plain `rm`
   * to a read-only gate.
   */
  transparent: boolean;
}

export const CARRIERS: Record<string, Carrier> = {
  // `sudo -u me curl x` used to keep the option's VALUE as the lead, and `curl` read as an argument
  // (#794). Both lists are closed on purpose: an option nobody enumerated costs a label, which is
  // the direction `_danger.ts` errs in.
  sudo: {
    values: [
      '-u',
      '-g',
      '-U',
      '-C',
      '-D',
      '-h',
      '-p',
      '-r',
      '-t',
      '-T',
      '-R',
      '--user',
      '--group',
      '--other-user',
      '--close-from',
      '--chdir',
      '--host',
      '--prompt',
      '--role',
      '--type',
      '--command-timeout',
    ],
    operands: 0,
    transparent: false,
  },
  // `env` takes its options and its `VAR=value` operands in any order, so the walk keeps it in place
  // across an assignment. `-S`/`--split-string` is here as well: its value is already read as a
  // program of its own by `_danger.ts`'s `nestedBodies`, and skipping the value silently would be
  // the one direction that file does not take.
  env: {
    values: ['-u', '-C', '-S', '-P', '--unset', '--chdir', '--split-string', '--path'],
    operands: 0,
    transparent: false,
  },
  exec: { values: ['-a', '--argv0'], operands: 0, transparent: false },
  time: { values: ['-o', '-f', '--output', '--format'], operands: 0, transparent: false },
  command: { values: [], operands: 0, transparent: false },
  nohup: { values: [], operands: 0, transparent: false },
  // `timeout [OPTION] DURATION COMMAND`: the DURATION is a positional operand, and `-s`/`-k` take
  // values (`timeout -s KILL 5 curl`, `timeout 5 -k 1s curl` — GNU's parser permutes, so a flag may
  // follow the duration as well as precede it). `--signal=KILL` carries its value attached and eats
  // no word.
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], operands: 1, transparent: true },
  // `nice [-n N | -N] COMMAND`, plus `--adjustment=N`. The legacy `nice -10 curl` is one word that
  // starts with `-` and takes no value, which the option arm below already reads correctly.
  nice: { values: ['-n', '--adjustment'], operands: 0, transparent: true },
};

const VALUE_SETS = new Map(
  Object.entries(CARRIERS).map(([name, carrier]) => [name, new Set(carrier.values)]),
);

/** Whether `word` (already read as an option) consumes the next word as its value. */
export function carrierOptionValue(carrier: string, word: string): boolean {
  if (VALUE_SETS.get(carrier)?.has(word)) return true;
  // A BUNDLED short spelling (`sudo -iu me`, `env -iu PATH …`) follows getopt: the letters are read
  // left to right, and the FIRST one that takes a value takes the rest of the bundle as that value
  // (`-ume` is `-u me`, `-of x` is `-o f`) unless it is the bundle's LAST letter, in which case the
  // value is the next word (`-iu me` is `-i -u me`). Anything else eats nothing. A long spelling
  // carrying `=` (`--user=me`) keeps its value attached and never reaches here.
  if (!/^-[a-zA-Z]+$/.test(word)) return false;
  for (let i = 1; i < word.length; i++) {
    if (VALUE_SETS.get(carrier)?.has(`-${word[i]}`)) return i === word.length - 1;
  }
  return false;
}

/**
 * The index of the word the carrier at `start` hands to — past its own options and operands — or -1
 * when `wordList[start]` is not a carrier (or, with `transparentOnly`, not one that leaves the
 * command's effect alone). Callers loop, because carriers nest: `timeout 5 nice gh …` is two.
 */
export function skipCarrier(
  wordList: readonly string[],
  start: number,
  transparentOnly = false,
): number {
  const carrier = CARRIERS[wordList[start] ?? ''];
  if (!carrier || (transparentOnly && !carrier.transparent)) return -1;
  let i = start + 1;
  let operands = carrier.operands;
  while (i < wordList.length) {
    const word = wordList[i];
    // `--` ends the carrier's options: the next word is the command, even one spelled `-x`.
    if (word === '--') {
      i++;
      break;
    }
    // A bare `-` is an operand, not an option, so it falls through to the operand count.
    if (word.startsWith('-') && word !== '-') {
      i += carrierOptionValue(wordList[start], word) ? 2 : 1;
      continue;
    }
    if (operands <= 0) break;
    operands--;
    i++;
  }
  return Math.min(i, wordList.length);
}
