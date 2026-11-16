#!/bin/bash
# Check out the eka2l1 submodule with the nested submodules the web build
# reads, and nothing else.
#   tools/ci/checkout-eka2l1.sh
# The fork has 41 nested submodules, fetched from GitHub; a recursive clone is
# 840 MB. The web target leaves a dozen of them out (the JITs, FFmpeg, the
# desktop audio and window libraries), and of the submodules' own submodules it
# needs only mbedtls' framework. Everything is fetched at depth 1.
#
# The fork itself lives on this forge and may be private. With FORGE_TOKEN in
# the environment (an access token of the forge with repository read access,
# or a CI job's own token) the fork is fetched with it; without, git uses
# whatever credentials the machine has. The token is handed to git through a
# credential helper for the forge's host only, so it is never part of a URL or
# a command line, and the nested submodules on GitHub are fetched anonymously.
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

# shallow_update <git> <repository> <path>...: check the submodules out at
# depth 1. <git> names an array holding the git command to use, which lets the
# one fetch that needs credentials carry them. A server that will not hand out
# a commit by its id unless a branch points at it (SourceForge, where
# opencore-amr lives) makes the shallow fetch fail; that submodule then gets
# its full history instead.
shallow_update() {
  local -n git_command=$1
  local repo=$2 path; shift 2
  # --checkout because a developer checkout may be configured not to update
  # the submodule by itself (submodule.eka2l1.update=none).
  "${git_command[@]}" -C "$repo" submodule update --init --checkout --depth 1 --jobs 8 -- "$@" && return
  for path in "$@"; do
    "${git_command[@]}" -C "$repo" submodule update --init --checkout --depth 1 -- "$path" 2>/dev/null && continue
    echo "checkout-eka2l1: no shallow fetch for $path, fetching its history" >&2
    if [ -e "$repo/$path/.git" ]; then
      "${git_command[@]}" -C "$repo/$path" fetch --unshallow origin '+refs/heads/*:refs/remotes/origin/*' ||
        "${git_command[@]}" -C "$repo/$path" fetch origin '+refs/heads/*:refs/remotes/origin/*' || return
    fi
    "${git_command[@]}" -C "$repo" submodule update --init --checkout -- "$path" || return
  done
}
PLAIN_GIT=(git)

# Never wait for someone to type a password.
export GIT_TERMINAL_PROMPT=0

# The fork: a repository of the forge this checkout came from. The token is
# only for an https remote; an ssh one brings its own key.
FORGE=$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -nE 's#^(https?://[^/]+)/.*#\1#p' || true)
FORK_GIT=(git)
USED_TOKEN=
if [ -n "${FORGE_TOKEN:-}" ] && [ -n "$FORGE" ]; then
  # git passes credential.* settings, and only those, on to the clone it
  # starts for a submodule. The helper reads the token from the environment
  # when git asks; the empty first value drops any helper configured before.
  FORK_GIT=(git -c "credential.$FORGE.helper=" -c "credential.$FORGE.helper=!f() { test \"\$1\" = get && echo username=x-access-token && echo \"password=\$FORGE_TOKEN\"; }; f")
  USED_TOKEN=1
fi
if ! shallow_update FORK_GIT "$ROOT" eka2l1; then
  echo "checkout-eka2l1: could not fetch the eka2l1 submodule${FORGE:+ from $FORGE}." >&2
  if [ -n "$USED_TOKEN" ]; then
    echo "  FORGE_TOKEN was used and did not get in. In CI it is the FORGE_TOKEN secret, or the job's" >&2
    echo "  own token when that secret is not set; a job's token cannot be relied on to read another" >&2
    echo "  private repository." >&2
  elif [ -n "${FORGE_TOKEN:-}" ]; then
    echo "  FORGE_TOKEN is set but was not used: this checkout's origin is not an https URL." >&2
  else
    echo "  FORGE_TOKEN is not set." >&2
  fi
  echo "  If the fork is private, create an access token on the forge with repository read access" >&2
  echo "  and set it as the secret FORGE_TOKEN on this repository or its organisation." >&2
  exit 1
fi
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
shallow_update PLAIN_GIT "$EKA" "${PATHS[@]}"

while read -r parent inner; do
  [ -n "$parent" ] || continue
  shallow_update PLAIN_GIT "$EKA/$parent" "$inner"
done <<< "$NESTED"

echo "checkout-eka2l1: eka2l1 at $(git -C "$EKA" rev-parse HEAD)"
