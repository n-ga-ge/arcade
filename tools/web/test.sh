#!/bin/bash
# Rebuild the web target if needed and run the headless smoke test.
#   tools/web/test.sh [run_test.mjs options...]
# The dev server (tools/web/devserver.py) must already be running on :8080.
W=/home/user/Documents/ShadowkeyWebPort; TC=$W/.toolchain
. $TC/env.sh
export PLAYWRIGHT_BROWSERS_PATH=$TC/pw-browsers
ninja -C $W/eka2l1/build/web eka2l1_web 2>&1 | grep -E 'error|FAILED|undefined' | head -20
cp $W/tools/web/run_test.mjs $TC/pw/run_test.mjs
cd $TC/pw && exec node run_test.mjs "$@"
