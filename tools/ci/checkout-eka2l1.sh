#!/bin/bash
# Check out the eka2l1 submodule with the nested submodules the web build
# reads, and nothing else.
#   tools/ci/checkout-eka2l1.sh
# The fork has 41 nested submodules, fetched from GitHub; a recursive clone is
# 840 MB. The web target leaves a dozen of them out (the JITs, FFmpeg, the
# desktop audio and window libraries), and of the submodules' own submodules it
# needs only mbedtls' framework. Everything is fetched at depth 1.
#
# SKIP lists what is left out rather than what is needed, so a submodule that
# upstream adds later is fetched without anyone editing this file. To check the
# list after a rebase onto upstream: every path in it must be absent from
# `ninja -C eka2l1/build/web -t deps` and from the CMake files named on the
# RERUN_CMAKE line of build.ninja.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

SKIP="
src/external/SDL_GameControllerDB
src/external/cubeb
src/external/discord-rpc
src/external/dynarmic
src/external/ffmpeg
src/external/glfw
src/external/libcxxabi
src/external/libuv
src/external/luajit
src/external/luajit-android-src
src/external/luajit-cmake
src/external/sdl2-cmake-scripts
"
# Submodules of submodules that are needed: "<submodule> <path inside it>".
NESTED="
src/external/mbedtls framework
"

# shallow_update <repository> <path>...: check the submodules out at depth 1.
# A server that will not hand out a commit by its id unless a branch points at
# it (SourceForge, where opencore-amr lives) makes the shallow fetch fail; that
# submodule then gets its full history instead.
shallow_update() {
  local repo=$1 path; shift
  # --checkout because a developer checkout may be configured not to update
  # the submodule by itself (submodule.eka2l1.update=none).
  git -C "$repo" submodule update --init --checkout --depth 1 --jobs 8 -- "$@" && return
  for path in "$@"; do
    git -C "$repo" submodule update --init --checkout --depth 1 -- "$path" 2>/dev/null && continue
    echo "checkout-eka2l1: no shallow fetch for $path, fetching its history" >&2
    if [ -e "$repo/$path/.git" ]; then
      git -C "$repo/$path" fetch --unshallow origin '+refs/heads/*:refs/remotes/origin/*' ||
        git -C "$repo/$path" fetch origin '+refs/heads/*:refs/remotes/origin/*'
    fi
    git -C "$repo" submodule update --init --checkout -- "$path"
  done
}

shallow_update "$ROOT" eka2l1
EKA=$ROOT/eka2l1

mapfile -t ALL < <(git -C "$EKA" config -f .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print $2}' | sort)
PATHS=()
for path in "${ALL[@]}"; do
  case " $(echo $SKIP) " in *" $path "*) ;; *) PATHS+=("$path") ;; esac
done
# A path in SKIP that no longer exists means the list is out of date.
for path in $SKIP; do
  case " ${ALL[*]} " in *" $path "*) ;; *) echo "checkout-eka2l1: $path is in SKIP but is not a submodule of eka2l1 any more" >&2; exit 1 ;; esac
done
echo "checkout-eka2l1: fetching ${#PATHS[@]} of ${#ALL[@]} nested submodules"
shallow_update "$EKA" "${PATHS[@]}"

while read -r parent inner; do
  [ -n "$parent" ] || continue
  shallow_update "$EKA/$parent" "$inner"
done <<< "$NESTED"

echo "checkout-eka2l1: eka2l1 at $(git -C "$EKA" rev-parse HEAD)"
