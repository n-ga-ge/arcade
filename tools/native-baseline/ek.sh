#!/bin/bash
# helper for the native EKA2L1 control API: ek.sh tap <key> [n] | shot <name> | stat
A=http://127.0.0.1:8765/v1; S="$(dirname "$0")"
case "$1" in
  tap) curl -s -m 30 -X POST $A/input/key -H 'Content-Type: application/json' -d "{\"key\":\"$2\",\"action\":\"tap\",\"repeat\":${3:-1},\"holdMs\":120,\"gapMs\":250}" >/dev/null;;
  shot) curl -s -m 10 -o "$S/$2.png" $A/screenshot; echo "$S/$2.png";;
  stat) curl -s -m 5 $A/status | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d['frames'], d['session']['state'])";;
esac
