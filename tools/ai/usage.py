#!/usr/bin/env python3
"""Count the AI model tokens spent on this project, and what they would cost.

  python3 -I tools/ai/usage.py           prints the "Tokens and cost" section
  python3 -I tools/ai/usage.py --write   replaces that section in docs/public/ai.md

The work is done with Claude Code, which keeps every conversation as a JSON
Lines transcript under ~/.claude/projects/<folder named after the checkout>/,
subagents' conversations included. Each API response in a transcript carries
its model and its token usage. This script adds them up per model, over the
folders whose name contains one of the --project strings (by default this
project's checkouts and worktrees, and the workspace's first name), and prices
them at Anthropic's published API rates (PRICES below).

The transcripts exist only on the machine the agents ran on, so this is run
there by hand and the page is committed; CI cannot run it. Its output names
models and numbers, nothing about the people or the machine.

A response is written to the transcript once per content block, each copy
with the same usage, so responses are counted once by message and request id.
A model without an entry in PRICES stops the script: add its rates rather than
publish a total that leaves it out.
"""
import argparse
import collections
import datetime
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PAGE = os.path.join(ROOT, "docs", "public", "ai.md")
HEADING = "## Tokens and cost"
PROJECTS = ["n-ga-ge", "ShadowkeyWebPort"]

# US dollars per million tokens: input, output, cache read, cache write for 5
# minutes, cache write for 1 hour. Anthropic's API list prices, November 2026.
# A cache write costs 1.25 times the input price for 5 minutes, twice for 1 hour.
PRICES_AS_OF = "November 2026"
PRICES = {
    "claude-fable-5-2": (8.00, 40.00, 0.20, 10.00, 16.00),
    "claude-fable-5-1": (10.00, 50.00, 0.25, 12.50, 20.00),
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00, 8.00),
    "claude-sonnet-5-5": (2.00, 10.00, 0.10, 2.50, 4.00),
}
FAST = 2.0   # fast mode costs twice the standard price
KINDS = ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h")


def collect(projects_dir, projects):
    seen = set()
    usage = collections.defaultdict(collections.Counter)
    sessions = set()
    stamps = []
    folders = [d for d in sorted(os.listdir(projects_dir)) if any(p in d for p in projects)]
    for folder in folders:
        for path in glob.glob(os.path.join(projects_dir, folder, "**", "*.jsonl"), recursive=True):
            with open(path, errors="replace") as lines:
                for line in lines:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if entry.get("type") != "assistant":
                        continue
                    message = entry.get("message") or {}
                    model, u = message.get("model"), message.get("usage")
                    if not model or not u or model.startswith("<"):   # "<synthetic>": no request was made
                        continue
                    key = (message.get("id"), entry.get("requestId"))
                    if key in seen:
                        continue
                    seen.add(key)
                    count = usage[model]
                    fast = u.get("speed") == "fast"
                    count["requests"] += 1
                    count["fast_requests"] += fast
                    parts = {
                        "input": u.get("input_tokens") or 0,
                        "output": u.get("output_tokens") or 0,
                        "cache_read": u.get("cache_read_input_tokens") or 0,
                    }
                    split = u.get("cache_creation") or {}
                    if "ephemeral_5m_input_tokens" in split or "ephemeral_1h_input_tokens" in split:
                        parts["cache_write_5m"] = split.get("ephemeral_5m_input_tokens") or 0
                        parts["cache_write_1h"] = split.get("ephemeral_1h_input_tokens") or 0
                    else:
                        parts["cache_write_5m"] = u.get("cache_creation_input_tokens") or 0
                        parts["cache_write_1h"] = 0
                    for kind, n in parts.items():
                        count[kind] += n
                        if fast:
                            count["fast_" + kind] += n
                    sessions.add(entry.get("sessionId"))
                    if entry.get("timestamp"):
                        stamps.append(entry["timestamp"])
    return usage, len(sessions), stamps


def cost(model, count):
    rates = PRICES[model]
    total = 0.0
    for kind, rate in zip(KINDS, rates):
        standard = count[kind] - count["fast_" + kind]
        total += (standard + FAST * count["fast_" + kind]) * rate / 1e6
    return total


def name(model):
    m = re.fullmatch(r"claude-([a-z]+)-(\d+)(?:-(\d+))?", model)
    if not m:
        return model
    return f"Claude {m.group(1).capitalize()} {m.group(2)}" + (f".{m.group(3)}" if m.group(3) else "")


def section(usage, sessions, stamps):
    unknown = sorted(m for m in usage if m not in PRICES)
    if unknown:
        sys.exit(f"no prices for {', '.join(unknown)}: add them to PRICES in {os.path.relpath(__file__, ROOT)}")
    days = sorted({s[:10] for s in stamps})
    models = sorted(usage, key=lambda m: -cost(m, usage[m]))
    total = collections.Counter()
    for m in models:
        total.update(usage[m])
    grand = sum(cost(m, usage[m]) for m in models)

    def row(label, c, dollars):
        writes = c["cache_write_5m"] + c["cache_write_1h"]
        return (f"| {label} | {c['requests']:,} | {c['input']:,} | {writes:,} | "
                f"{c['cache_read']:,} | {c['output']:,} | ${dollars:,.0f} |")

    out = [HEADING, ""]
    out.append(f"From {days[0]} to {days[-1]}, in {sessions:,} conversations with the agents:")
    out.append("")
    out.append("| Model | Requests | Input tokens | Cache writes | Cache reads | Output tokens | At API prices |")
    out.append("|---|---:|---:|---:|---:|---:|---:|")
    for m in models:
        out.append(row(name(m), usage[m], cost(m, usage[m])))
    if len(models) > 1:
        out.append(row("**Total**", total, grand))
    out.append("")
    if total["fast_requests"]:
        out.append(f"{total['fast_requests']:,} of the requests used fast mode, which costs twice"
                   " as much, and are priced that way.")
        out.append("")
    out += [
        "A request is one reply from the model, and an agent makes hundreds of",
        "them in a task. Each request sends the conversation so far. Most of it",
        "the model has seen before and reads back from a cache, at a small part",
        "of the price (cache reads); what is new is written to that cache (cache",
        "writes) or sent as plain input. Output tokens include the model's",
        "reasoning, not only the code and text it wrote.",
        "",
        f"The last column is what these tokens cost at Anthropic's API prices of",
        f"{PRICES_AS_OF}. The work ran on a flat-rate Claude subscription, so",
        "there was no bill per token: the figure says how much computing the",
        "work took, not what was paid.",
        "",
        "Counted by [a script](../../tools/ai/usage.py) from the transcripts the",
        "agents keep of every conversation. It does not see the few small",
        "requests the tools make without writing them down, such as the titles",
        f"of conversations. Figures as of {days[-1]}.",
        "",
    ]
    return "\n".join(out)


def write(text):
    with open(PAGE) as f:
        page = f.read()
    start = page.find("\n" + HEADING + "\n")
    if start < 0:
        sys.exit(f"{os.path.relpath(PAGE, ROOT)} has no line '{HEADING}'")
    start += 1
    end = page.find("\n## ", start + len(HEADING))
    rest = page[end + 1:] if end >= 0 else ""
    page = page[:start] + text + ("\n" + rest if rest else "")
    with open(PAGE, "w") as f:
        f.write(page.rstrip("\n") + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--write", action="store_true", help=f"replace the section in {os.path.relpath(PAGE, ROOT)}")
    parser.add_argument("--projects-dir", default=os.path.expanduser("~/.claude/projects"))
    parser.add_argument("--project", action="append",
                        help="count transcript folders whose name contains this (repeatable; default: %s)" % ", ".join(PROJECTS))
    args = parser.parse_args()
    usage, sessions, stamps = collect(args.projects_dir, args.project or PROJECTS)
    if not usage:
        sys.exit("no transcripts found")
    text = section(usage, sessions, stamps)
    if args.write:
        write(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
