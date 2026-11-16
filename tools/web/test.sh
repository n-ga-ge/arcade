#!/bin/bash
# Rebuild the web target if needed and run the headless smoke test.
#   tools/web/test.sh [run_test.mjs options...]
# The dev server (tools/web/devserver.py) must already be running on :8080.
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"
ninja -C $ARCADE_MAIN/eka2l1/build/web eka2l1_web 2>&1 | grep -E 'error|FAILED|undefined' | head -20
exec node $ARCADE_ROOT/tools/web/run_test.mjs "$@"
