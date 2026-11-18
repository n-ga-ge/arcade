#!/bin/bash
# Build the public mirror of arcade and the fork, check it, and push it.
#   tools/mirror/mirror.sh [--push] [--force-fork] [--work DIR] [--local]
# docs/mirror.md is the reference. Without --push nothing leaves this machine:
# the rewritten branches are left in DIR/arcade.git (refs/mirror/main) and
# DIR/fork.git (refs/mirror/web-port) to read, and what they would become is
# printed.
#
#   --push        push the fork's web-port, then arcade's main, to GitHub
#                 (needs GITHUBTOKEN). An ordinary push: a mirror that
#                 does not start with what GitHub has is refused
#   --force-fork  allow the fork's push to replace GitHub's web-port (after a
#                 rebase of web-port on the forge). arcade is never forced
#   --work DIR    where the bare repositories go (default: a new temporary
#                 folder, removed at the end unless --keep-work)
#   --keep-work   leave the default work folder in place
#   --local       read the repositories from this machine's checkouts
#                 ($ARCADE_MAIN and its eka2l1, their remote-tracking branches)
#                 instead of fetching them from the forge. MIRROR_ARCADE_SRC
#                 and MIRROR_ARCADE_REF pick another arcade (a branch not
#                 merged yet: MIRROR_ARCADE_SRC=$PWD MIRROR_ARCADE_REF=HEAD)
#
# Environment:
#   FORGE_TOKEN            reads the private repositories on the forge
#   GITHUBTOKEN            pushes to GitHub (--push only)
#   MIRROR_IDENTITIES      extra names, handles and addresses the check looks
#                          for, one per line (a secret)
#   MIRROR_IDENTITY        the project identity; default below
#   MIRROR_TOOL_ADDRESSES  addresses whose trailers stay, space-separated
#   MIRROR_GITHUB          default https://github.com/n-ga-ge
#   the names in SECRET_ENVS below: tokens of the project; the check fails on
#                          a file or a message containing the value of any
#                          that is set
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REWRITE=(python3 -I "$ROOT/tools/mirror/rewrite.py")

PUSH= FORCE_FORK= WORK= KEEP_WORK= LOCAL=
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1 ;;
    --force-fork) FORCE_FORK=1 ;;
    --work) WORK=$2; shift ;;
    --keep-work) KEEP_WORK=1 ;;
    --local) LOCAL=1 ;;
    *) echo "mirror: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

IDENTITY=${MIRROR_IDENTITY:-"n-ga.ge contributors <contributors@n-ga.ge>"}
TOOLS=${MIRROR_TOOL_ADDRESSES:-noreply@anthropic.com}
GITHUB=${MIRROR_GITHUB:-https://github.com/n-ga-ge}
TOOL_ARGS=()
for t in $TOOLS; do TOOL_ARGS+=(--tool-address "$t"); done
# What the mirror carries is source code only. Left out of every commit:
# - in both: notes for coding agents, and files that hold credentials by
#   convention (upstream's test certificates in the fork are not touched: a
#   private key the port adds is caught by the check's token patterns);
EXCLUDE_BOTH=('(^|/)(CLAUDE|AGENTS)\.md$' '(^|/)\.claude/' '(^|/)\.env(\.[^/]*)?$' '(^|/)\.netrc$' '(^|/)\.npmrc$')
# - arcade: all of its documentation (the overview README, docs/, the
#   components' READMEs: they describe the forge, the private repository and
#   the infrastructure), except docs/public/, which the site publishes anyway;
#   the mirror's README is tools/mirror/public/README.md. Also the workflow
#   kept here for the private repository, and key files;
MD_EXCEPT='docs/public/|tools/mirror/public/'
EXCLUDE_ARCADE=("(?i)^(?!$MD_EXCEPT).*\.(md|markdown)\$" '^docs/(?!public/)' '^tools/assets/private-repo/'
                '(?i)\.(pem|key|p12|pfx|keystore|jks)$')
# - the fork: its forge-only folder (a README pointing at the forge).
EXCLUDE_FORK=('^\.forgejo/')
# Never published at all, and never meant to be in either repository: the
# copyrighted inputs (CLAUDE.md, "Layout"). A match stops the mirror.
FORBID_ALWAYS=('(?i)(^|/)ngage\.rom$' '^(testdata|private|games)/')
# The project's secrets, by the names CI gives them (docs/ci.md, docs/deployment.md).
SECRET_ENVS=(FORGE_TOKEN GITHUBTOKEN ASSETS_TOKEN CLOUDFLARE_API_TOKEN_PAGES CLOUDFLARE_API_TOKEN_WORKERS
             CLOUDFLARE_API_TOKEN_R2 CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID)

args() { local flag=$1; shift; for x in "$@"; do printf '%s\0%s\0' "$flag" "$x"; done; }
mapfile -d '' FORK_EXCLUDE < <(args --exclude "${EXCLUDE_BOTH[@]}" "${EXCLUDE_FORK[@]}")
mapfile -d '' ARCADE_EXCLUDE < <(args --exclude "${EXCLUDE_BOTH[@]}" "${EXCLUDE_ARCADE[@]}")
# The check looks for the excluded paths again, independently of the rewrite
# (except arcade's README.md, which must be the mirror's own: checked below).
mapfile -d '' FORK_FORBID < <(args --forbid-path "${FORBID_ALWAYS[@]}" "${EXCLUDE_BOTH[@]}" "${EXCLUDE_FORK[@]}")
mapfile -d '' ARCADE_FORBID < <(args --forbid-path "${FORBID_ALWAYS[@]}" "${EXCLUDE_BOTH[@]}" \
  "(?i)^(?!$MD_EXCEPT|README\.md\$).*\.(md|markdown)\$" "${EXCLUDE_ARCADE[@]:1}")
mapfile -d '' SECRET_ARGS < <(args --secret-env "${SECRET_ENVS[@]}")
PUBLIC_README=tools/mirror/public/README.md

export GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1
say() { echo "$1"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "- $1" >> "$GITHUB_STEP_SUMMARY"; }

if [ -z "$WORK" ]; then
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/mirror.XXXXXX")
  [ -n "$KEEP_WORK" ] || trap 'rm -rf "$WORK"' EXIT
fi
mkdir -p "$WORK"
ARC=$WORK/arcade.git FORK=$WORK/fork.git
rm -rf "$ARC" "$FORK"
git init -q --bare "$ARC"
git init -q --bare "$FORK"

# Where the three inputs come from: the forge by default, the token handed to
# git by a credential helper for the forge's host only (as in
# tools/ci/checkout-eka2l1.sh), so it is never in a URL or a command line.
FORGE_GIT=(git)
MAIN=${ARCADE_MAIN:-$ROOT}
origin=$(git -C "$( [ -n "$LOCAL" ] && echo "$MAIN" || echo "$ROOT")" remote get-url origin)
FORGE=$(echo "$origin" | sed -nE 's#^(https?://[^/]+)/.*#\1#p')
ORG=$(echo "$origin" | sed -nE 's#^https?://[^/]+/([^/]+)/.*#\1#p')
[ -n "$FORGE" ] && [ -n "$ORG" ] || { echo "mirror: cannot tell the forge from the remote origin" >&2; exit 1; }
if [ -n "$LOCAL" ]; then
  ARCADE_SRC=${MIRROR_ARCADE_SRC:-$MAIN} ARCADE_REF=${MIRROR_ARCADE_REF:-refs/remotes/origin/main}
  FORK_SRC=$MAIN/eka2l1 FORK_REF=refs/remotes/origin/web-port FORK_HEADS=refs/remotes/origin
  UPSTREAM_SRC=$MAIN/eka2l1 UPSTREAM_REF=refs/remotes/upstream/master
else
  ARCADE_SRC=$FORGE/$ORG/arcade.git ARCADE_REF=refs/heads/main
  FORK_SRC=$FORGE/$ORG/EKA2L1.git FORK_REF=refs/heads/web-port FORK_HEADS=refs/heads
  UPSTREAM_SRC=$FORGE/$ORG/EKA2L1-sync.git UPSTREAM_REF=refs/heads/master
  if [ -n "${FORGE_TOKEN:-}" ]; then
    FORGE_GIT=(git -c "credential.$FORGE.helper=" -c "credential.$FORGE.helper=!f() { test \"\$1\" = get && echo username=x-access-token && echo \"password=\$FORGE_TOKEN\"; }; f")
  fi
fi

# The forge must not be named anywhere in the copy (not even in this file,
# which is published: everything about it is worked out from the remote).
# Links to its two published repositories become links to their copies; any
# other mention of its host stops the mirror in the check.
HOST=${FORGE#*://}
DOMAIN=$(echo "$HOST" | awk -F. 'NF > 2 { $1 = ""; sub(/^ /, ""); gsub(/ /, "."); print; next } { print }')
REPLACE=(
  --replace "$FORGE/$ORG/arcade/src/branch/main/" "$GITHUB/arcade/blob/main/"
  --replace "$FORGE/$ORG/EKA2L1/src/branch/web-port/" "$GITHUB/EKA2L1/blob/web-port/"
  --replace "$FORGE/$ORG/EKA2L1-sync" "https://github.com/EKA2L1/EKA2L1"
  --replace "$FORGE/$ORG/arcade" "$GITHUB/arcade"
  --replace "$FORGE/$ORG/EKA2L1" "$GITHUB/EKA2L1"
)
# Home folders in old scripts name the person whose machine it was.
HOME_RE='/home/(?!user/)[A-Za-z0-9._-]+/'
FORBID_TEXT=(--forbid-text "$HOST" --forbid-text "$DOMAIN" --forbid-regex "$HOME_RE")

echo "mirror: fetching arcade, the fork and upstream"
"${FORGE_GIT[@]}" -C "$ARC" fetch -q --no-tags "$ARCADE_SRC" "+$ARCADE_REF:refs/heads/main"
"${FORGE_GIT[@]}" -C "$FORK" fetch -q --no-tags "$UPSTREAM_SRC" "+$UPSTREAM_REF:refs/upstream/master"
# All of the fork's branches and tags, for pins that are not on web-port.
"${FORGE_GIT[@]}" -C "$FORK" fetch -q --no-tags "$FORK_SRC" "+$FORK_REF:refs/heads/web-port" \
  "+$FORK_HEADS/*:refs/forge/heads/*" "+refs/tags/*:refs/forge/tags/*"

# The fork: web-port, plus each commit arcade ever pinned that is not on
# web-port (or upstream) but that the forge still has, so that arcade's old
# pins keep meaning something after a rebase of web-port.
EXTRA_TIPS=() LOST=0
while read -r pin; do
  if git -C "$FORK" merge-base --is-ancestor "$pin" refs/upstream/master 2>/dev/null ||
     git -C "$FORK" merge-base --is-ancestor "$pin" refs/heads/web-port 2>/dev/null; then
    continue
  elif git -C "$FORK" cat-file -e "$pin^{commit}" 2>/dev/null; then
    EXTRA_TIPS+=(--tip "$pin")
  else
    LOST=$((LOST + 1))
  fi
done < <("${REWRITE[@]}" pins --repo "$ARC" --tip refs/heads/main)
say "arcade pins $((${#EXTRA_TIPS[@]} / 2)) fork commits that are not on web-port; $LOST that the fork no longer has"

"${REWRITE[@]}" rewrite --repo "$FORK" --tip refs/heads/web-port "${EXTRA_TIPS[@]}" \
  --keep refs/upstream/master --out-ref refs/mirror/web-port --map "$WORK/fork.map" \
  --identity "$IDENTITY" "${TOOL_ARGS[@]}" "${FORK_EXCLUDE[@]}" "${REPLACE[@]}"
"${REWRITE[@]}" rewrite --repo "$ARC" --tip refs/heads/main --out-ref refs/mirror/main \
  --map "$WORK/arcade.map" --gitlink-map "$WORK/fork.map" --gitlink-repo "$FORK" \
  --gitlink-keep refs/upstream/master --gitlink-path eka2l1 --identity "$IDENTITY" "${TOOL_ARGS[@]}" "${ARCADE_EXCLUDE[@]}" \
  --put "README.md=$PUBLIC_README" "${REPLACE[@]}" --replace-regex "$HOME_RE" /home/user/

FORK_TIPS=(--tip refs/mirror/web-port)
for ((i = 1; i <= ${#EXTRA_TIPS[@]} / 2; i++)); do FORK_TIPS+=(--tip "refs/mirror/web-port/$i"); done
FORK_ORIG=(--original refs/heads/web-port "${EXTRA_TIPS[@]/--tip/--original}")
"${REWRITE[@]}" check --repo "$FORK" "${FORK_TIPS[@]}" --keep refs/upstream/master "${FORK_ORIG[@]}" \
  --identity "$IDENTITY" "${TOOL_ARGS[@]}" --identities-env MIRROR_IDENTITIES "${SECRET_ARGS[@]}" "${FORK_FORBID[@]}" "${FORBID_TEXT[@]}" \
  --save-identities "$WORK/identities"
# arcade's check also covers the fork commits its pins name: they must be in
# the rewritten fork, which the check above has passed.
"${REWRITE[@]}" check --repo "$ARC" --tip refs/mirror/main --original refs/heads/main \
  --identity "$IDENTITY" "${TOOL_ARGS[@]}" --identities-env MIRROR_IDENTITIES --identities-file "$WORK/identities" "${SECRET_ARGS[@]}" "${ARCADE_FORBID[@]}" "${FORBID_TEXT[@]}"
rm -f "$WORK/identities"
readme=$(git -C "$ARC" rev-parse -q --verify "refs/mirror/main:README.md" || true)
[ "$readme" = "$(git -C "$ARC" rev-parse -q --verify "refs/mirror/main:$PUBLIC_README" || true)" ] ||
  { echo "mirror: arcade's README.md in the mirror is not $PUBLIC_README" >&2; exit 1; }
pin_old=$(git -C "$ARC" rev-parse refs/heads/main:eka2l1)
pin_new=$(git -C "$ARC" rev-parse refs/mirror/main:eka2l1)
web_new=$(git -C "$FORK" rev-parse refs/mirror/web-port)
git -C "$FORK" cat-file -e "$pin_new^{commit}" || { echo "mirror: arcade's newest pin $pin_new is not in the rewritten fork" >&2; exit 1; }
git -C "$FORK" merge-base --is-ancestor "$pin_new" "$web_new" ||
  echo "mirror: note: arcade's newest pin is not on web-port"

say "arcade main: $(git -C "$ARC" rev-parse refs/mirror/main) ($(git -C "$ARC" rev-list --count refs/mirror/main) commits), pinning the fork at $pin_new (on the forge $pin_old)"
say "fork web-port: $web_new ($(git -C "$FORK" rev-list --count refs/mirror/web-port ^refs/upstream/master) commits on top of upstream)"
echo "mirror: authors in the rewritten branches:"
git -C "$ARC" log --format='  arcade: %an <%ae>' refs/mirror/main | sort | uniq -c
git -C "$FORK" log --format='  fork:   %an <%ae>' refs/mirror/web-port ^refs/upstream/master | sort | uniq -c
echo "mirror: the newest rewritten commits:"
git -C "$ARC" log -3 --format='  arcade %h %ad %an: %s' --date=iso-strict refs/mirror/main
git -C "$FORK" log -3 --format='  fork   %h %ad %an: %s' --date=iso-strict refs/mirror/web-port

if [ -z "$PUSH" ]; then
  say "dry run: nothing pushed (rewritten branches in $WORK${KEEP_WORK:+, kept})"
  exit 0
fi
[ -n "${GITHUBTOKEN:-}" ] || { echo "mirror: --push needs GITHUBTOKEN" >&2; exit 1; }
GH_GIT=(git -c credential.https://github.com.helper= -c "credential.https://github.com.helper=!f() { test \"\$1\" = get && echo username=x-access-token && echo \"password=\$GITHUBTOKEN\"; }; f")

# The fork first: arcade's pins name its commits.
fork_refs=("$web_new:refs/heads/web-port")
for ((i = 1; i <= ${#EXTRA_TIPS[@]} / 2; i++)); do
  c=$(git -C "$FORK" rev-parse "refs/mirror/web-port/$i")
  fork_refs+=("$c:refs/tags/pinned/${c:0:12}")
done
lease=()
if [ -n "$FORCE_FORK" ]; then
  current=$("${GH_GIT[@]}" ls-remote "$GITHUB/EKA2L1.git" refs/heads/web-port | awk '{print $1}')
  lease=("--force-with-lease=refs/heads/web-port:$current")
  echo "mirror: --force-fork: GitHub's web-port ${current:-(none)} may be replaced"
fi
# push_to <name> <repo> <git push arguments>...: push, and when GitHub refuses,
# say why in words. The fork goes first and arcade only after it, so that
# arcade's pin never names a commit GitHub does not have.
push_to() {
  local name=$1 repo=$2 out status; shift 2
  out=$("${GH_GIT[@]}" -C "$repo" push --porcelain "$@" 2>&1) && status=0 || status=$?
  echo "$out" | grep -v '^remote: *$'
  [ "$status" = 0 ] && return 0
  echo "mirror: GitHub refused the push of $name; nothing of it was published." >&2
  case "$out" in
    *"without \`workflow\` scope"*|*"workflow scope"*|*"without workflow"*)
      echo "  The token may not change workflows, and $name carries .github/workflows/ (upstream's, in the fork)." >&2
      echo "  Give GITHUBTOKEN the workflow scope (classic) or Workflows: Read and write (fine-grained) and run again." >&2 ;;
    *"Authentication failed"*|*"Invalid username or token"*|*"Permission to "*" denied"*|*"403"*)
      echo "  GITHUBTOKEN was not accepted, or may not write to $GITHUB/$name: check the token and its repositories." >&2 ;;
    *"Repository not found"*)
      echo "  $GITHUB/$name does not exist, or the token cannot see it." >&2 ;;
    *"non-fast-forward"*|*"fetch first"*|*"stale info"*)
      if [ "$name" = EKA2L1 ]; then
        echo "  The rewritten web-port does not start with GitHub's. After a rebase of web-port on the forge," >&2
        echo "  run the workflow by hand with push and force_fork (docs/mirror.md, 'Rebasing the fork')." >&2
      else
        echo "  The rewritten main does not start with GitHub's: something changed the rewrite (the identity," >&2
        echo "  the tool addresses, the rules). Read docs/mirror.md before forcing anything." >&2
      fi ;;
    *) echo "  The reason is in git's output above." >&2 ;;
  esac
  return 1
}
push_to EKA2L1 "$FORK" "${lease[@]}" "$GITHUB/EKA2L1.git" "${fork_refs[@]}" || exit 1
push_to arcade "$ARC" "$GITHUB/arcade.git" "refs/mirror/main:refs/heads/main" || exit 1
say "pushed: $GITHUB/EKA2L1 web-port and $GITHUB/arcade main"
