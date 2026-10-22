#!/usr/bin/env bash
# Prints the CHANGELOG.md section for a version, the GitHub release notes for that tag.
# Fails when the section is missing or empty, so a release cannot go out without an entry.
set -euo pipefail

version="${1:?usage: release-notes.sh X.Y.Z}"
changelog="$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md"

# A release body renders a single newline as a line break, where the changelog file treats it as a
# space, so the formatter's 100-column wrap would show as ragged lines on the release page.
unwrap() {
  awk '
    /^[[:space:]]*$/ { flush(); print; next }
    /^(#|[-*] |[0-9]+\. )/ { flush(); buf = $0; next }
    { sub(/^[[:space:]]+/, ""); buf = (buf == "" ? $0 : buf " " $0) }
    function flush() { if (buf != "") print buf; buf = "" }
    END { flush() }
  '
}

notes="$(awk -v head="## [$version]" '
  index($0, head) == 1 { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$changelog" | sed -e '/./,$!d' | unwrap)"

[ -n "$notes" ] || { echo "no CHANGELOG.md entry for $version" >&2; exit 1; }
printf '%s\n' "$notes"
