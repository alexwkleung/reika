#!/bin/sh
# Link Reika's in-repo skills (.reika/skills/) into the global skills dir, so they
# work in every project instead of only inside this checkout. Symlinks, not copies —
# `git pull` then updates the skills everywhere without re-running this.
#
# Usage: npm run skills:link [-- --force]
#   --force  replace a regular file in the global dir with a link to ours
set -eu

force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) echo "usage: $0 [--force]" >&2; exit 2 ;;
  esac
done

src="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)/.reika/skills"
target="${REIKA_SKILLS_DIR:-$HOME/.config/reika/skills}"
# The loader expands a leading ~ in REIKA_SKILLS_DIR; do the same so both agree on the path.
case "$target" in '~') target="$HOME" ;; '~/'*) target="$HOME/${target#\~/}" ;; esac

mkdir -p "$target"
for entry in "$src"/*; do
  [ -e "$entry" ] || continue
  name="$(basename -- "$entry")"
  # Everything the loader accepts: a flat NAME.md, or a NAME/ directory holding SKILL.md.
  if [ ! -d "$entry" ]; then
    case "$name" in *.md) ;; *) continue ;; esac
  fi
  dest="$target/$name"
  if [ -L "$dest" ]; then
    # Re-point rather than skip: an existing link may aim at a moved or stale checkout.
    # rm first — `ln -f` over a link to a directory is BSD/GNU-divergent, `rm` is not
    # (it drops the link, never what it points at).
    rm -f "$dest"
    ln -s "$entry" "$dest"
    echo "relinked $name"
  elif [ -e "$dest" ] && [ "$force" -eq 0 ]; then
    echo "skipped  $name — $dest already exists (--force to replace it with a link)" >&2
  elif [ -e "$dest" ]; then
    rm -rf "$dest"
    ln -s "$entry" "$dest"
    echo "replaced $name"
  else
    ln -s "$entry" "$dest"
    echo "linked   $name"
  fi
done
echo "global skills dir: $target"
