#!/bin/bash
# TEMPORARY stand-in for unit 3's tools/ci/deploy.sh: publishes nothing, only
# shows what a deployment would have had to work with.
set -euo pipefail
echo "stand-in deploy: DEPLOY_TARGET=$DEPLOY_TARGET DEPLOY_BRANCH=$DEPLOY_BRANCH CF_PAGES_PROJECT=$CF_PAGES_PROJECT"
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do [ -n "${!name:-}" ] && echo "$name is set"; done
ls dist dist/play dist/catalog | head -60
echo "screenshots: $(ls dist/catalog/shots 2>/dev/null | wc -l)"
python3 -I -c 'import json; d=json.load(open("dist/catalog/index.json")); print("index:", len(d["games"]), "games,", sum(1 for g in d["games"] if g.get("ci")), "with a CI result, commit", d.get("commit"))'
# Nothing copyrighted may be in the site.
if find dist -iname '*.rom' -o -iname '*.zip' | grep .; then echo "game files in dist" >&2; exit 1; fi
