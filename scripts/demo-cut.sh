#!/usr/bin/env bash
# Cuts the raw take from docs/demo.tape into docs/demo.gif (the README's copy) and
# docs/public/demo.mp4 + demo-poster.webp (the site's, ~6x smaller): the typed prompt at normal
# speed, the model's turn sped up, then a short hold on the result. Needs ffmpeg and cwebp
# (`brew install ffmpeg webp`).
#   scripts/demo-cut.sh <turn-end-seconds> [raw.mp4] [speed]
# Find the turn end by scrubbing the raw take for the "Worked for …" line.
set -euo pipefail

end=${1:?usage: scripts/demo-cut.sh <turn-end-seconds> [raw.mp4] [speed]}
raw=${2:-/tmp/reika-demo-raw.mp4}
speed=${3:-3}
typed=7   # seconds of prompt typing kept at normal speed
hold=5    # seconds held on the final screen
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

IFS=x read -r w h < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$raw")

# VHS sometimes captures a frame mid-redraw (a status line cut short); demo-deflicker.py swaps
# those for the previous frame.
ffmpeg -v error -y -i "$raw" -filter_complex "\
[0:v]trim=0:$typed,setpts=PTS-STARTPTS[a];\
[0:v]trim=$typed:$end,setpts=(PTS-STARTPTS)/$speed[b];\
[0:v]trim=$end:$(echo "$end + $hold" | bc),setpts=PTS-STARTPTS[c];\
[a][b][c]concat=n=3:v=1,fps=12" -f rawvideo -pix_fmt rgb24 - |
  python3 "$here/demo-deflicker.py" "$w" "$h" |
  ffmpeg -v error -y -f rawvideo -pix_fmt rgb24 -s "${w}x${h}" -r 12 -i - -c:v ffv1 "$tmp/cut.mkv"

ffmpeg -v error -y -i "$tmp/cut.mkv" -filter_complex \
  "split[x][y];[x]palettegen=max_colors=64:stats_mode=diff[p];[y][p]paletteuse=dither=none:diff_mode=rectangle" \
  "$here/../docs/demo.gif"
# The poster is the first frame, so a browser that won't autoplay (iOS Low Power Mode) shows the
# splash instead of a blank box, and one that does play has no visible jump.
ffmpeg -v error -y -i "$tmp/cut.mkv" -movflags +faststart -pix_fmt yuv420p \
  -c:v libx264 -crf 28 -preset veryslow -tune animation "$here/../docs/public/demo.mp4"
ffmpeg -v error -y -i "$tmp/cut.mkv" -frames:v 1 "$tmp/poster.png"
cwebp -quiet -q 80 "$tmp/poster.png" -o "$here/../docs/public/demo-poster.webp"

ls -la "$here/../docs/demo.gif" "$here/../docs/public/demo.mp4" "$here/../docs/public/demo-poster.webp"
