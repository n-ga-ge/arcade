#!/usr/bin/env python3
"""TEMPORARY stand-in for unit 1's tools/assets/fetch.py: writes empty
placeholder files instead of downloading anything."""
import argparse, os, pathlib, sys
p = argparse.ArgumentParser(); p.add_argument('--fw', action='store_true'); p.add_argument('slugs', nargs='+'); p.add_argument('--out', required=True)
a = p.parse_args()
for name in ('ASSETS_URL', 'ASSETS_TOKEN'):
    if not os.environ.get(name):
        sys.exit(f'{name} is not set')
out = pathlib.Path(a.out); (out / 'games').mkdir(parents=True, exist_ok=True)
if a.fw:
    (out / 'NGAGE.ROM').write_bytes(b'')
for slug in a.slugs:
    (out / 'games' / f'{slug}.zip').write_bytes(b'')
print('stand-in fetch:', a.slugs, 'from', len(os.environ['ASSETS_URL']), 'character URL')
