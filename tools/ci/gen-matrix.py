#!/usr/bin/env python3
"""Print the CI job matrix: one entry per game in the catalogue.

  python3 -I tools/ci/gen-matrix.py [--catalog DIR] [--pretty]

Prints two lines in the form a workflow step appends to $GITHUB_OUTPUT:

  slugs=["alien-front","ashen",...]             the matrix, in title order
  titles={"alien-front":"Alien Front",...}      what each job is called

The matrix holds only the slugs because Forgejo names a job of a matrix that
comes from another job's output "<name> (<matrix values>)": with the title as
the name and the slug as the only value, a job reads "Alien Front
(alien-front)", and the slug keeps the names apart should two titles be equal.
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


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--catalog', type=pathlib.Path, default=ROOT / 'catalog' / 'games')
    parser.add_argument('--pretty', action='store_true', help='one game per line, for reading')
    args = parser.parse_args()
    games = load(args.catalog)
    games.sort(key=lambda game: (game['title'].casefold(), game['slug']))
    if args.pretty:
        for game in games:
            print(f"{game['slug']:40} {game['title']}")
        return
    # One line each, ASCII only: safe to pass through a job output.
    dump = lambda value: json.dumps(value, ensure_ascii=True, separators=(',', ':'))
    print('slugs=' + dump([game['slug'] for game in games]))
    print('titles=' + dump({game['slug']: game['title'] for game in games}))


if __name__ == '__main__':
    main()
