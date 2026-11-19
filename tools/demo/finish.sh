#!/bin/bash
# The last step of the demo video: the poster, and the two encodes.
#   tools/demo/finish.sh
# Needs <work>/silent.mp4 (render.mjs video) and <work>/music.wav (music.py).
# Writes into <work>:
#   demo.jpg        the poster: a frame of its own (t = -1 in comp.html)
#   demo.mp4        CRF 16, the one the site serves at /demo.mp4; must stay
#                   under Cloudflare Pages' 25 MiB per file
#   demo-small.mp4  CRF 19, preset veryslow: for places with a 20 MB limit
# Both have the poster as frame 0 (platforms take their thumbnail from it)
# and the soundtrack lowered by 1.1 dB to about -14 LUFS.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=${DEMO_WORK:-$ROOT/demo-work}
FF=${FFMPEG:-$WORK/ffmpeg/node_modules/ffmpeg-static/ffmpeg}
FRAMES=1140

node "$ROOT/tools/demo/render.mjs" stills "$WORK/poster" -1
"$FF" -loglevel error -y -i "$WORK/poster/t-1.00.png" -q:v 2 "$WORK/demo.jpg"

encode() { # crf preset out
  "$FF" -loglevel error -y -i "$WORK/silent.mp4" -i "$WORK/demo.jpg" -i "$WORK/music.wav" \
    -filter_complex "[1:v]format=yuv420p[p];[0:v][p]overlay=0:0:enable='eq(n,0)'[v];[2:a]volume=-1.1dB[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset "$2" -tune animation -crf "$1" -pix_fmt yuv420p -r 30 \
    -c:a aac -b:a 160k -movflags +faststart "$WORK/$3"
  local frames bytes
  frames=$("$FF" -hide_banner -i "$WORK/$3" -map 0:v -c copy -f null - 2>&1 | grep -oE 'frame= *[0-9]+' | tail -n 1 | grep -oE '[0-9]+')
  bytes=$(stat -c %s "$WORK/$3")
  echo "$3: $frames frames, $bytes bytes"
  [ "$frames" = "$FRAMES" ] || { echo "finish.sh: $3 has $frames frames, not $FRAMES" >&2; exit 1; }
}
encode 16 slow demo.mp4
[ "$(stat -c %s "$WORK/demo.mp4")" -lt $((25 * 1024 * 1024)) ] || { echo "finish.sh: demo.mp4 is over 25 MiB, which Pages refuses: raise its CRF" >&2; exit 1; }
encode 19 veryslow demo-small.mp4
"$FF" -hide_banner -i "$WORK/demo.mp4" -map 0:a -af ebur128 -f null - 2>&1 | grep -E '^ +I:' | sed 's/^ */loudness: /'
