#!/usr/bin/env python3
"""TEMPORARY stand-in for unit 5's tools/ci/status.py."""
import argparse, datetime, json, os, pathlib, shutil
p = argparse.ArgumentParser(); p.add_argument('results'); p.add_argument('--out', required=True)
a = p.parse_args()
out = pathlib.Path(a.out); (out / 'shots').mkdir(parents=True, exist_ok=True)
games = {}
for f in sorted(pathlib.Path(a.results).glob('*.json')):
    r = json.loads(f.read_text()); slug = r.pop('slug')
    games[slug] = r
    shot = f.with_suffix('.png')
    if shot.exists():
        shutil.copy(shot, out / 'shots' / shot.name)
status = {'generated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), 'commit': os.environ.get('GITHUB_SHA'), 'games': games}
(out / 'status.json').write_text(json.dumps(status, indent=1))
print(f'{len(games)} results, {sum(g["pass"] for g in games.values())} passed, {len(list((out / "shots").iterdir()))} screenshots')
print('files in results:', sorted(x.name for x in pathlib.Path(a.results).iterdir())[:6], '...')
