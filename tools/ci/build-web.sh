#!/bin/bash
# Configure and build the web target.
#   tools/ci/build-web.sh [eka2l1 checkout] [build dir]
# Output: <build dir>/bin (default eka2l1/build/web/bin). Needs cmake, ninja and
# Emscripten on PATH: tools/env.sh supplies them from .toolchain locally, and
# tools/ci/setup-toolchain.sh installs them on a clean CI machine.
set -eo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"
SOURCE=${1:-$ARCADE_ROOT/eka2l1}
BUILD=${2:-$SOURCE/build/web}
[ -f "$SOURCE/CMakeLists.txt" ] || { echo "no EKA2L1 checkout at $SOURCE: git submodule update --init --recursive eka2l1" >&2; exit 1; }
emcmake cmake -S "$SOURCE" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
ninja -C "$BUILD" eka2l1_web
ls -l "$BUILD/bin/eka2l1_web.wasm"
