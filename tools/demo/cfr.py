#!/usr/bin/env python3
"""Turn a recording (frames/, times.json, rect.json from a screencast) into
<dir>/cfr/0000.jpg ... at a steady 30 frames a second, cropped to the game's
picture inside the canvas.

  python3 -I tools/demo/cfr.py <dir> [--full]

A screencast sends a frame only when the page changes, with its time; each
frame is held until the next one's time. --full keeps the whole page instead
of cropping. The crop leaves out one row and column at each edge, where the
picture meets the letterbox. Needs ffmpeg ($FFMPEG, else the static one in
<work>/ffmpeg/: docs/demo-video.md).
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.abspath(os.environ.get("DEMO_WORK") or os.path.join(ROOT, "demo-work"))
FFMPEG = os.environ.get("FFMPEG") or os.path.join(WORK, "ffmpeg", "node_modules", "ffmpeg-static", "ffmpeg")

d = sys.argv[1]
full = "--full" in sys.argv
times = json.load(open(os.path.join(d, "times.json")))
r = json.load(open(os.path.join(d, "rect.json")))
# The picture keeps the screen's 176:208 inside the canvas element.
if r["w"] / r["h"] > 176 / 208:
    ph = r["h"]; pw = ph * 176 / 208
else:
    pw = r["w"]; ph = pw * 208 / 176
x = r["x"] + (r["w"] - pw) / 2
y = r["y"] + (r["h"] - ph) / 2
w, h = int(pw) - 2, int(ph) - 2

with open(os.path.join(d, "concat.txt"), "w") as f:
    for i, t in enumerate(times):
        duration = (times[i + 1] - t) if i + 1 < len(times) else 1 / 30
        f.write(f"file 'frames/f{i:05d}.jpg'\nduration {duration:.4f}\n")
    f.write(f"file 'frames/f{len(times) - 1:05d}.jpg'\n")
os.makedirs(os.path.join(d, "cfr"), exist_ok=True)
vf = "fps=30" if full else f"crop={w}:{h}:{int(x) + 1}:{int(y) + 1},fps=30"
subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", os.path.join(d, "concat.txt"),
                "-vf", vf, "-q:v", "2", "-start_number", "0", os.path.join(d, "cfr", "%04d.jpg")], check=True)
print(d, len(os.listdir(os.path.join(d, "cfr"))), "frames", "whole page" if full else f"{w}x{h}+{int(x) + 1}+{int(y) + 1}")
