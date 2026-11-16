# source this from a shell or script, in the main checkout or in a git worktree of it.
#   ARCADE_ROOT  the checkout this file belongs to
#   ARCADE_MAIN  the main checkout, which holds what git does not: .toolchain/,
#                testdata/, games/ and the prebuilt web build. Same as ARCADE_ROOT
#                unless this is a worktree.
# Puts the user-space toolchain on PATH when there is one (on CI the tools are
# installed system-wide instead) and links its Node packages into the checkout
# so the scripts under tools/ can import playwright and pngjs in place.
ARCADE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
_common=$(git -C "$ARCADE_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
case "$_common" in */.git) ARCADE_MAIN=${ARCADE_MAIN:-$(dirname "$_common")} ;; *) ARCADE_MAIN=${ARCADE_MAIN:-$ARCADE_ROOT} ;; esac
unset _common
export ARCADE_ROOT ARCADE_MAIN
if [ -z "$EKA2L1_TOOLCHAIN" ]; then
  for _c in "$ARCADE_ROOT/.toolchain" "$ARCADE_MAIN/.toolchain"; do
    if [ -f "$_c/env.sh" ]; then EKA2L1_TOOLCHAIN=$_c; break; fi
  done
  unset _c
fi
if [ -n "$EKA2L1_TOOLCHAIN" ] && [ -f "$EKA2L1_TOOLCHAIN/env.sh" ]; then
  . "$EKA2L1_TOOLCHAIN/env.sh"
  if [ ! -e "$ARCADE_ROOT/node_modules" ] && [ -d "$EKA2L1_TOOLCHAIN/pw/node_modules" ]; then
    ln -s "$EKA2L1_TOOLCHAIN/pw/node_modules" "$ARCADE_ROOT/node_modules"
  fi
fi
