#!/bin/bash
# Push the current branch and open a pull request on the Forgejo instance.
#   tools/forge/pr.sh "<title>" <body file> [base branch]
# Run it inside the repository the pull request is for: this checkout, or the
# eka2l1 submodule (whose default base is web-port instead of main). Prints the
# pull request as "PR: <url>". If the branch already has an open pull request,
# the push updates it and its URL is printed.
#
# The access token is read from FORGEJO_TOKEN, or from the file
# FORGEJO_TOKEN_FILE (default ~/.config/n-ga.ge/forgejo-token). It needs
# repository write access.
set -eo pipefail
TITLE=$1; BODY_FILE=$2
[ -n "$TITLE" ] && [ -f "$BODY_FILE" ] || { echo "usage: pr.sh \"<title>\" <body file> [base]" >&2; exit 2; }
TOKEN=${FORGEJO_TOKEN:-$(cat "${FORGEJO_TOKEN_FILE:-$HOME/.config/n-ga.ge/forgejo-token}")}
URL=$(git remote get-url origin)
case "$URL" in
  https://*) ;;
  *) echo "origin is not an https URL: $URL" >&2; exit 1 ;;
esac
HOST=$(echo "$URL" | sed -E 's#https://([^/]+)/.*#\1#')
REPO=$(echo "$URL" | sed -E 's#https://[^/]+/(.*)#\1#; s#\.git$##; s#/$##')
BRANCH=$(git symbolic-ref --short HEAD)
case "$REPO" in */EKA2L1) DEFAULT_BASE=web-port ;; *) DEFAULT_BASE=main ;; esac
BASE=${3:-$DEFAULT_BASE}
[ "$BRANCH" != "$BASE" ] || { echo "on $BASE itself: create a branch first" >&2; exit 1; }

# The token goes to git through a one-off helper, never into the URL or the config.
export PR_TOKEN=$TOKEN
git -c credential.helper= -c "credential.https://$HOST.helper=" \
    -c "credential.https://$HOST.helper=!f() { test \"\$1\" = get && echo username=token && echo \"password=\$PR_TOKEN\"; }; f" \
    push -u origin "$BRANCH"

API=https://$HOST/api/v1/repos/$REPO
PAYLOAD=$(python3 -I -c 'import json,sys; print(json.dumps({"title": sys.argv[1], "body": open(sys.argv[2]).read(), "head": sys.argv[3], "base": sys.argv[4]}))' "$TITLE" "$BODY_FILE" "$BRANCH" "$BASE")
RESPONSE=$(curl -sS -m 60 -X POST -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' "$API/pulls" -d "$PAYLOAD")
LINK=$(echo "$RESPONSE" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("html_url") or "")' 2>/dev/null || true)
if [ -z "$LINK" ]; then
  # Most likely the pull request exists already: look it up by its head branch.
  LINK=$(curl -sS -m 60 -H "Authorization: token $TOKEN" "$API/pulls?state=open&limit=50" |
    python3 -I -c 'import json,sys; b=sys.argv[1]; print(next((p["html_url"] for p in json.load(sys.stdin) if p["head"]["ref"] == b), ""))' "$BRANCH" 2>/dev/null || true)
fi
if [ -z "$LINK" ]; then
  echo "could not open a pull request: $RESPONSE" >&2
  exit 1
fi
echo "PR: $LINK"
