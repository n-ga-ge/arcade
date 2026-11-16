#!/bin/bash
# Rebuild the web target and run the browser test suite (see suite.mjs for options).
#   tools/web/suite.sh [--browsers chrome,firefox] [--tests support,boot,...] [--out DIR]
# Uses the dev server on :8080 if one is running; otherwise starts one for the
# duration of the run.
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"
W=$ARCADE_ROOT
ninja -C $ARCADE_MAIN/eka2l1/build/web eka2l1_web 2>&1 | grep -E 'error|FAILED|undefined' | head -20

if ! curl -s -m 3 -o /dev/null http://127.0.0.1:8080/; then
  python3 -I $W/tools/web/devserver.py 8080 >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  for _ in $(seq 1 50); do curl -s -m 1 -o /dev/null http://127.0.0.1:8080/ && break; sleep 0.1; done
fi

node $W/tools/web/suite.mjs --out $W/tools/web/results "$@"
