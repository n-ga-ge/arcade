#!/bin/bash
# Rebuild the web target and run the browser test suite (see suite.mjs for options).
#   tools/web/suite.sh [--browsers chrome,firefox] [--tests support,boot,...] [--out DIR]
# The dev server (tools/web/devserver.py) must be running on :8080.
W=/home/user/Documents/ShadowkeyWebPort; TC=$W/.toolchain
. $TC/env.sh
export PLAYWRIGHT_BROWSERS_PATH=$TC/pw-browsers EKA2L1_TOOLCHAIN=$TC
ninja -C $W/eka2l1/build/web eka2l1_web 2>&1 | grep -E 'error|FAILED|undefined' | head -20
cp $W/tools/web/suite.mjs $TC/pw/suite.mjs
cd $TC/pw && exec node suite.mjs --out $W/tools/web/results "$@"
