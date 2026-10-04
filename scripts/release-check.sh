#!/usr/bin/env bash
# Smoke-test the package a user would install: pack, install it with npm into a
# throwaway prefix, run the binary, import every shipped module. `--help` exits
# before most modules load, so only the import pass catches a dependency missing
# from the package. Prints the tarball's sha256, which the Homebrew formula pins:
# publish this exact file (`npm publish <tgz>`) and the registry serves these bytes.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/reika-release.XXXXXX")"
keep="${KEEP:-0}"
cleanup() { if [ "$keep" = 1 ]; then echo "kept: $work"; else rm -rf "$work"; fi; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

version="$(node -p "require('$repo/package.json').version")"

step "pack reika@$version (prepack builds dist/)"
(cd "$repo" && pnpm pack --pack-destination "$work" >/dev/null)
tgz="$work/reika-$version.tgz"
[ -f "$tgz" ] || fail "expected $tgz"

step "tarball contents"
listing="$(tar -tzf "$tgz")"
echo "$(echo "$listing" | wc -l | tr -d ' ') files, $(du -h "$tgz" | cut -f1) packed"
for required in package/dist/cli.js package/LICENSE package/NOTICE package/README.md package/skills/; do
  echo "$listing" | grep -q "^$required" || fail "missing $required"
done
# Tests, sources and local config must never ship.
leaked="$(echo "$listing" | grep -E '\.test\.|^package/(src|evals|docs|scripts)/|\.env$' || true)"
[ -z "$leaked" ] || fail "unexpected files in tarball:"$'\n'"$leaked"

step "npm install -g into a throwaway prefix"
prefix="$work/prefix"
npm install -g --prefix "$prefix" --no-audit --no-fund --loglevel=error "$tgz" >/dev/null
bin="$prefix/bin/reika"
pkg="$prefix/lib/node_modules/reika"
[ -x "$bin" ] || fail "no executable at $bin"

# Run from an empty cwd under an empty HOME so neither a project .env nor
# ~/.config/reika can make the check pass on this machine and fail on another.
home="$work/home"
mkdir -p "$home" "$work/cwd"
run() { (cd "$work/cwd" && env -i PATH="$PATH" HOME="$home" TERM=dumb "$bin" "$@"); }

step "reika --version"
got="$(run --version)"
echo "$got"
[ "$got" = "$version" ] || [ "$got" = "reika $version" ] || fail "--version printed '$got', want $version"

step "reika --help"
run --help | head -3
echo "…"

step "import every dist module from the installed copy"
(cd "$work/cwd" && env -i PATH="$PATH" HOME="$home" node --input-type=module - "$pkg/dist" <<'EOF'
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const files = readdirSync(root, { recursive: true })
  .filter((f) => f.endsWith('.js'))
  // cli.js runs the app on import; the --version and --help runs above load it.
  .filter((f) => f !== 'cli.js')
  .sort();
const failed = [];
for (const f of files) {
  try {
    await import(pathToFileURL(join(root, f)).href);
  } catch (err) {
    failed.push(`${f}: ${err.message.split('\n')[0]}`);
  }
}
console.log(`${files.length - failed.length}/${files.length} modules imported`);
if (failed.length) {
  console.error(failed.join('\n'));
  process.exit(1);
}
process.exit(0);
EOF
) || fail "a shipped module does not import"

step "ok"
sha="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
echo "sha256:  $sha"
if [ -n "${OUT:-}" ]; then
  mkdir -p "$OUT" && cp "$tgz" "$OUT/"
  echo "tarball: $OUT/$(basename "$tgz")  (publish this file: npm publish <path>)"
else
  echo "tarball: not kept (OUT=<dir> keeps the tested file for npm publish)"
fi
