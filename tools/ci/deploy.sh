#!/bin/bash
# Publish the built site (dist/) to Cloudflare Pages and deploy the assets Worker.
#   tools/ci/deploy.sh [--dry-run] [--branch <name>]
#
# Build first: python3 -I tools/site/build.py. One-time Cloudflare setup, the
# API token and the CI secrets are described in cloudflare/pages/README.md.
#
# Environment:
#   CLOUDFLARE_API_TOKEN_PAGES    API token for the deployment (secret). The plain
#                                 CLOUDFLARE_API_TOKEN, wrangler's own name, is
#                                 used when this one is not set.
#   CLOUDFLARE_API_TOKEN_WORKERS  optional: a separate token for the Worker, when
#                                 the Pages token has no Workers permissions
#   CLOUDFLARE_ACCOUNT_ID         account the Pages project and the Worker live in (secret)
#   CF_PAGES_PROJECT              Pages project name (variable; default n-ga-ge)
#
# The branch decides what is deployed. "main" is production: the site goes
# live, and the Worker in cloudflare/assets-worker/ (when that folder exists)
# is deployed after it. Any other branch becomes a Pages preview deployment at
# https://<branch>.<project>.pages.dev and leaves the Worker alone; so does a
# pull request and a tag, whatever they are called. The branch and the commit
# come from --branch, else from Forgejo's CI variables, else from the checkout.
#
# --dry-run does everything that needs no credentials: it resolves the branch
# and the commit, checks dist/ again, fetches the pinned wrangler, bundles the
# Worker without uploading it (installing its packages if they are missing),
# and prints what a real run would execute.
#
# The last line of output is "Deployment URL: <url>". In CI the URL is also
# written to the step outputs "url", "alias" and "environment".
set -eo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

# One wrangler version for every run, so a deployment does not change with
# whatever npm publishes that day. Raise it deliberately, with a dry run.
WRANGLER_VERSION=4.160.1
PRODUCTION_BRANCH=main
PROJECT=${CF_PAGES_PROJECT:-n-ga-ge}
DIST=$ARCADE_ROOT/dist
WORKER_DIR=$ARCADE_ROOT/cloudflare/assets-worker
API=${CLOUDFLARE_API_BASE_URL:-https://api.cloudflare.com/client/v4}

die() { echo "deploy.sh: $1" >&2; shift; for line in "$@"; do echo "  $line" >&2; done; exit 1; }

DRY_RUN=
BRANCH=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --branch) [ -n "${2:-}" ] || die "--branch needs a name"; BRANCH=$2; shift ;;
    --branch=*) BRANCH=${1#--branch=}; [ -n "$BRANCH" ] || die "--branch needs a name" ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" "usage: tools/ci/deploy.sh [--dry-run] [--branch <name>]" ;;
  esac
  shift
done

# Forgejo sets FORGEJO_* (runner 7 and later) and the GITHUB_* names it has
# always had. For a pull request the ref is refs/pull/<n>/head, so the head
# branch is the name to use.
EVENT=${FORGEJO_EVENT_NAME:-${GITHUB_EVENT_NAME:-}}
if [ -z "$BRANCH" ]; then
  BRANCH=${FORGEJO_HEAD_REF:-${GITHUB_HEAD_REF:-}}
  if [ -z "$BRANCH" ]; then
    BRANCH=${FORGEJO_REF_NAME:-${GITHUB_REF_NAME:-}}
    # A tag is not a branch: it gets a preview of its own, even one called main.
    [ "${FORGEJO_REF_TYPE:-${GITHUB_REF_TYPE:-}}" != tag ] || BRANCH=tag-$BRANCH
  fi
  [ -n "$BRANCH" ] || BRANCH=$(git -C "$ARCADE_ROOT" symbolic-ref --short -q HEAD || true)
  [ -n "$BRANCH" ] || die "cannot tell which branch this is (detached HEAD, no CI variables): pass --branch <name>"
fi
# A pull request must never reach production, whatever its branch is called
# (a fork's "main", for one) and whatever --branch says.
case "$EVENT" in
  pull_request*)
    if [ "$BRANCH" = "$PRODUCTION_BRANCH" ]; then
      BRANCH=pr-$BRANCH
      echo "This is a pull request: deploying a preview as \"$BRANCH\", not production."
    fi ;;
esac
COMMIT=${FORGEJO_SHA:-${GITHUB_SHA:-$(git -C "$ARCADE_ROOT" rev-parse HEAD 2>/dev/null || true)}}
# Only the summary line: Pages rejects some long or multi-line messages.
MESSAGE=$(git -C "$ARCADE_ROOT" log -1 --format=%s "${COMMIT:-HEAD}" 2>/dev/null || true)
[ -n "$MESSAGE" ] || MESSAGE="Deploy ${COMMIT:0:12}"
if [ "$BRANCH" = "$PRODUCTION_BRANCH" ]; then ENVIRONMENT=production; else ENVIRONMENT=preview; fi

echo "Pages project: $PROJECT"
echo "Branch:        $BRANCH ($ENVIRONMENT)"
echo "Commit:        ${COMMIT:-unknown}  $MESSAGE"

# --- checks that need no credentials -----------------------------------------

[ -f "$DIST/play/eka2l1_web.wasm" ] || die "no built site at $DIST: run python3 -I tools/site/build.py first"
# The build ran this check already; dist/ may have been touched since, and
# what is uploaded here is public.
python3 -I "$ARCADE_ROOT/tools/site/steps/90-cloudflare.py" "$DIST" --check
command -v npx >/dev/null || die "npx is not on PATH: wrangler needs Node.js 22 or later"

# Tokens are stored per job (..._PAGES here, ..._R2 for the upload); wrangler
# only reads CLOUDFLARE_API_TOKEN, so the deployment's token is handed to it
# under that name.
if [ -n "${CLOUDFLARE_API_TOKEN_PAGES:-}" ]; then
  export CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_PAGES
fi

MISSING=()
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || MISSING+=(CLOUDFLARE_API_TOKEN_PAGES)
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || MISSING+=(CLOUDFLARE_ACCOUNT_ID)
if [ ${#MISSING[@]} -gt 0 ] && [ -z "$DRY_RUN" ]; then
  die "not set: ${MISSING[*]}" \
      "In CI they are Actions secrets of the repository; locally, export them." \
      "cloudflare/pages/README.md says how to create the token and where the account ID is." \
      "Use --dry-run to check everything else without them."
fi

# wrangler runs from an empty folder: there it finds no configuration file,
# no functions/ folder and no git checkout to guess from, so the flags below
# are all it goes by, and its cache does not land in the checkout.
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/deploy.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
export WRANGLER_SEND_METRICS=false
wrangler() { npx --yes "wrangler@$WRANGLER_VERSION" "$@"; }

PAGES_COMMAND=(pages deploy "$DIST" --project-name "$PROJECT" --branch "$BRANCH" --commit-message "$MESSAGE")
[ -z "$COMMIT" ] || PAGES_COMMAND+=(--commit-hash "$COMMIT")
show() { printf '  npx wrangler@%s' "$WRANGLER_VERSION"; printf ' %q' "$@"; printf '\n'; }

if [ -n "$DRY_RUN" ]; then
  echo "wrangler:      $(cd "$WORK" && wrangler --version </dev/null | tail -n 1)"
  [ ${#MISSING[@]} -eq 0 ] || echo "Not set (a real run stops here): ${MISSING[*]}"
  echo "Would run:"
  show "${PAGES_COMMAND[@]}"
  if [ ! -d "$WORKER_DIR" ]; then
    echo "No cloudflare/assets-worker/ in this checkout: no Worker to deploy."
  else
    if [ "$ENVIRONMENT" = production ]; then
      echo "and then, in cloudflare/assets-worker/:"
      show deploy
    else
      echo "The Worker is only deployed from $PRODUCTION_BRANCH."
    fi
    echo "Checking that the Worker builds:"
    # Bundling needs the Worker's packages. A clean checkout (CI) gets them
    # installed; an existing node_modules is left as it is.
    if [ -f "$WORKER_DIR/package-lock.json" ] && [ ! -d "$WORKER_DIR/node_modules" ]; then
      (cd "$WORKER_DIR" && npm ci --no-audit --no-fund)
    fi
    (cd "$WORKER_DIR" && wrangler deploy --dry-run --outdir "$WORK/worker" </dev/null)
  fi
  echo "Deployment URL: none (dry run, nothing was deployed)"
  exit 0
fi

# --- the Pages project must exist and agree about what production is -----------

# Pages, not this script, decides between production and preview: a deployment
# is production exactly when its branch is the project's production branch.
# Asking first also turns a wrong token or project name into a clear message.
# The token goes to curl through stdin, not through the command line.
STATUS=$(curl -sS -m 60 -o "$WORK/project.json" -w '%{http_code}' -K - \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT" <<EOF || true
header = "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
EOF
)
PROJECT_BRANCH=$(python3 -I -c '
import json, sys
try:
    reply = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    reply = {}
result = reply.get("result") or {}
if reply.get("success") and result.get("production_branch"):
    print("ok", result["production_branch"])
else:
    print("error", "; ".join(str(e.get("code")) + " " + str(e.get("message")) for e in reply.get("errors") or []))
' "$WORK/project.json")
case "$STATUS:$PROJECT_BRANCH" in
  200:ok\ *) PROJECT_BRANCH=${PROJECT_BRANCH#ok } ;;
  404:*|*:error\ 8000007\ *)
    die "the Pages project \"$PROJECT\" does not exist in account $CLOUDFLARE_ACCOUNT_ID." \
        "Create it once (cloudflare/pages/README.md):" \
        "npx wrangler@$WRANGLER_VERSION pages project create $PROJECT --production-branch $PRODUCTION_BRANCH" \
        "or set the variable CF_PAGES_PROJECT to the name of the existing project." ;;
  401:*|403:*)
    die "Cloudflare rejected CLOUDFLARE_API_TOKEN_PAGES (HTTP $STATUS: ${PROJECT_BRANCH#error })." \
        "The token must be valid for account $CLOUDFLARE_ACCOUNT_ID and include Account > Cloudflare Pages > Edit." ;;
  *) die "could not read the Pages project \"$PROJECT\" (HTTP ${STATUS:-none}: ${PROJECT_BRANCH#error })." ;;
esac
if [ "$ENVIRONMENT" = production ] && [ "$PROJECT_BRANCH" != "$BRANCH" ]; then
  die "the production branch of the Pages project \"$PROJECT\" is \"$PROJECT_BRANCH\", not \"$PRODUCTION_BRANCH\":" \
      "this deployment would become a preview. Change the project's production branch (cloudflare/pages/README.md)."
fi
if [ "$ENVIRONMENT" = preview ] && [ "$PROJECT_BRANCH" = "$BRANCH" ]; then
  die "\"$BRANCH\" is the production branch of the Pages project \"$PROJECT\":" \
      "this deployment would replace the live site. Change the project's production branch to \"$PRODUCTION_BRANCH\" (cloudflare/pages/README.md)."
fi

# --- Pages ----------------------------------------------------------------------

echo "Deploying $DIST to Pages ($ENVIRONMENT)..."
# wrangler records what it deployed in this file, one JSON object per line.
(cd "$WORK" && WRANGLER_OUTPUT_FILE_PATH="$WORK/pages.ndjson" wrangler "${PAGES_COMMAND[@]}" </dev/null)
RESULT=$(python3 -I -c '
import json, sys
found = {}
try:
    for line in open(sys.argv[1]):
        entry = json.loads(line)
        if entry.get("type") in ("pages-deploy", "pages-deploy-detailed"):
            found.update({key: value for key, value in entry.items() if value})
except (OSError, ValueError):
    pass
print(found.get("url") or "-", found.get("alias") or "-", found.get("environment") or "-")
' "$WORK/pages.ndjson")
read -r URL ALIAS DEPLOYED_AS <<<"$RESULT"
[ "$URL" != - ] || die "wrangler finished without reporting a deployment URL; see its output above"
[ "$ALIAS" != - ] || ALIAS=
[ "$DEPLOYED_AS" != - ] || DEPLOYED_AS=$ENVIRONMENT
echo "Pages deployment ($DEPLOYED_AS): $URL${ALIAS:+ (alias $ALIAS)}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "url=$URL"; echo "alias=$ALIAS"; echo "environment=$DEPLOYED_AS"; } >>"$GITHUB_OUTPUT"
fi

# --- the assets Worker (production only) -------------------------------------------

if [ ! -d "$WORKER_DIR" ]; then
  echo "No cloudflare/assets-worker/ in this checkout: no Worker to deploy."
elif [ "$ENVIRONMENT" != production ]; then
  echo "Preview deployment: the assets Worker is only deployed from $PRODUCTION_BRANCH."
else
  echo "Deploying the assets Worker..."
  [ ! -f "$WORKER_DIR/package-lock.json" ] || (cd "$WORKER_DIR" && npm ci --no-audit --no-fund)
  (cd "$WORKER_DIR" && CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN_WORKERS:-$CLOUDFLARE_API_TOKEN} wrangler deploy </dev/null) ||
    die "the Worker deployment failed. The site itself was deployed: $URL" \
        "If the token only covers Pages, add the Workers permissions to it or set CLOUDFLARE_API_TOKEN_WORKERS (cloudflare/pages/README.md)."
fi

echo "Deployment URL: $URL"
