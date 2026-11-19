#!/usr/bin/env python3
"""Site build step: the demo video at /demo.mp4.

  python3 -I 40-demo.py <output folder>      (run by tools/site/build.py)

The video shows games running, so like the screenshots it is never committed
to this repository: it is kept in the private repository as
media/demo.mp4 (docs/demo-video.md). This step copies the first of these that
exists:

  $DEMO_VIDEO                                   a path given by hand
  <checkout>/private/media/demo.mp4             the private repository cloned
                                                as private/, or the file CI
                                                fetched there (tools/ci/fetch-demo.sh)
  $ARCADE_MAIN/private/media/demo.mp4           the same in the main checkout,
                                                for a build in a worktree

Without any of them the site is built without /demo.mp4, and the step says
so; nothing else on the site depends on the video. The build stops when the
file is not an MP4 or is over the 25 MiB Cloudflare Pages takes per file.
"""
import os
import shutil
import sys

ROOT = os.environ.get("ARCADE_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MAX_BYTES = 25 * 1024 * 1024


def candidates():
    if os.environ.get("DEMO_VIDEO"):
        yield os.environ["DEMO_VIDEO"]
    yield os.path.join(ROOT, "private", "media", "demo.mp4")
    if os.environ.get("ARCADE_MAIN"):
        yield os.path.join(os.environ["ARCADE_MAIN"], "private", "media", "demo.mp4")


def main():
    out = sys.argv[1]
    source = next((path for path in candidates() if os.path.isfile(path)), None)
    if source is None:
        if os.environ.get("DEMO_VIDEO"):
            sys.exit(f"40-demo.py: DEMO_VIDEO names {os.environ['DEMO_VIDEO']}, which does not exist")
        print("40-demo.py: no demo video (private/media/demo.mp4): /demo.mp4 left out")
        return
    size = os.path.getsize(source)
    with open(source, "rb") as fh:
        head = fh.read(12)
    if head[4:8] != b"ftyp":
        sys.exit(f"40-demo.py: {source} is not an MP4 file")
    if size >= MAX_BYTES:
        sys.exit(f"40-demo.py: {source} is {size} bytes, over the 25 MiB Cloudflare Pages takes per file: encode it smaller (tools/demo/finish.sh)")
    shutil.copyfile(source, os.path.join(out, "demo.mp4"))
    print(f"40-demo.py: /demo.mp4 from {source} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
