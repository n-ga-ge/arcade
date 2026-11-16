#!/usr/bin/env python3
"""Print the CI job matrix: one entry per game in the catalogue.

  python3 -I tools/ci/gen-matrix.py [--catalog DIR] [--pretty]

The output is one line of JSON, a list of {"slug", "title"} objects sorted by
title, which the workflow feeds to `strategy.matrix` through `fromJSON`. The
title becomes the job's name, and Forgejo needs every job of a matrix to have
its own name, so a title that occurs twice gets its slug appended.
"""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(catalog):
    games = []
    for path in sorted(catalog.glob('*.json')):
        try:
            entry = json.loads(path.read_text(encoding='utf-8'))
            slug, title = entry['slug'], entry['title']
        except (ValueError, KeyError, TypeError) as error:
            sys.exit(f'{path}: not a usable catalogue entry ({error!r}); run tools/games/validate.py')
        # The slug ends up in file names, artifact names and command lines.
        if slug != path.stem or not isinstance(title, str) or not title.strip():
            sys.exit(f'{path}: slug {slug!r} must match the file name and the title must not be empty')
        games.append({'slug': slug, 'title': ' '.join(title.split())})
    if not games:
        sys.exit(f'no catalogue entries in {catalog}')
    return games


def unique_titles(games):
    seen = {}
    for game in games:
        seen[game['title'].casefold()] = seen.get(game['title'].casefold(), 0) + 1
    for game in games:
        if seen[game['title'].casefold()] > 1:
            game['title'] = f"{game['title']} ({game['slug']})"
    return games


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--catalog', type=pathlib.Path, default=ROOT / 'catalog' / 'games')
    parser.add_argument('--pretty', action='store_true', help='one game per line, for reading')
    args = parser.parse_args()
    games = unique_titles(load(args.catalog))
    games.sort(key=lambda game: (game['title'].casefold(), game['slug']))
    if args.pretty:
        for game in games:
            print(f"{game['slug']:40} {game['title']}")
    else:
        # ensure_ascii keeps the line safe to pass through a job output.
        print(json.dumps(games, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
