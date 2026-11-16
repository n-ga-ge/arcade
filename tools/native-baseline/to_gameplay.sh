#!/bin/bash
# drive native EKA2L1 from a fresh process to in-world gameplay in Shadowkey
A=http://127.0.0.1:8765/v1; S="$(dirname "$0")"
for i in $(seq 1 25); do sleep 1; curl -s -m 2 $A/status >/dev/null && break; done
curl -s -m 60 -X POST $A/apps/0x101FD3F6/launch >/dev/null
sleep 6; for i in 1 2 3 4; do "$S/ek.sh" tap ok; sleep 2.5; done
for i in $(seq 1 11); do "$S/ek.sh" tap ok; sleep 2; done
"$S/ek.sh" tap down 4; sleep 1; "$S/ek.sh" tap ok; sleep 4
"$S/ek.sh" tap down; sleep 1; "$S/ek.sh" tap ok; sleep 12
