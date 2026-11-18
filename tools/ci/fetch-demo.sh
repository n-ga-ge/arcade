#!/bin/bash
# Fetch the demo video from the private repository into private/media/demo.mp4,
# where tools/site/steps/40-demo.py finds it.
#   tools/ci/fetch-demo.sh
#
# The video shows games, so it is kept in n-ga.ge/private (media/demo.mp4) and
# never in this repository (docs/demo-video.md). FORGE_TOKEN in the
# environment is a token of the forge that can read that repository, and
# FORGE_URL is the forge's address (CI passes its own). The token goes in a header read
# from a file, never on a command line. When the fetch fails the site is built
# without /demo.mp4: the step says so, and the build goes on.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT="$ROOT/private/media/demo.mp4"

if [ -z "${FORGE_TOKEN:-}" ] || [ -z "${FORGE_URL:-}" ]; then
  echo "fetch-demo.sh: FORGE_TOKEN or FORGE_URL is not set: the site is built without /demo.mp4"
  exit 0
fi
mkdir -p "$(dirname "$OUT")"
header=$(mktemp)
trap 'rm -f "$header"' EXIT
printf 'Authorization: token %s\n' "$FORGE_TOKEN" > "$header"
# /media/ answers with the file itself, also when it is stored with Git LFS.
if curl -fsS --retry 3 -H @"$header" -o "$OUT.part" "$FORGE_URL/api/v1/repos/n-ga.ge/private/media/media/demo.mp4?ref=main"; then
  mv "$OUT.part" "$OUT"
  echo "fetch-demo.sh: $(stat -c %s "$OUT") bytes from n-ga.ge/private media/demo.mp4"
else
  rm -f "$OUT.part"
  echo "::warning::fetch-demo.sh: could not fetch media/demo.mp4 from n-ga.ge/private: the site is built without /demo.mp4"
fi
