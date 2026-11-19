#!/usr/bin/env bash
# Cuts the raw take from docs/demo.tape into docs/demo.gif: the typed prompt at normal speed, the
# model's turn sped up, then a short hold on the result. docs/demo-web.mjs's take goes through the
# same cut, so the two gifs match. Also writes <out>-poster.png, the last frame, for the landing.
#   scripts/demo-cut.sh <turn-end-seconds> [raw.mp4] [speed] [out.gif]
# Find the turn end by scrubbing the raw take for the "Worked for …" line.
set -euo pipefail

end=${1:?usage: scripts/demo-cut.sh <turn-end-seconds> [raw.mp4] [speed] [out.gif]}
raw=${2:-/tmp/reika-demo-raw.mp4}
speed=${3:-3}
here=$(cd "$(dirname "$0")" && pwd)
out=${4:-$here/../docs/demo.gif}
typed=7   # seconds of prompt typing kept at normal speed
hold=5    # seconds held on the final screen
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
  "$out"
# The landing's still for prefers-reduced-motion: the take's last frame.
ffmpeg -v error -y -sseof -0.2 -i "$tmp/cut.mkv" -frames:v 1 -update 1 "${out%.gif}-poster.png"
ls -la "$out" "${out%.gif}-poster.png"
