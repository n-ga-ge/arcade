#!/usr/bin/env python3
"""Rewrite a branch for the public mirror, and check the result.

docs/mirror.md is the reference. Standard library only; git does the object
storage.

  rewrite.py rewrite --repo DIR --tip REF [--tip REF]... [--keep REF]...
             --out-ref REF --map FILE [--gitlink-map FILE --gitlink-repo DIR
             [--gitlink-keep REF]...] [--identity "Name <address>"]
             [--tool-address ADDR]... [--exclude REGEX]... [--put NAME=PATH]...
  rewrite.py check   --repo DIR --tip REV [--tip REV]... [--keep REF]...
             --original REF [--original REF]... [--identity ...]
             [--tool-address ADDR]... [--identities-env NAME]
             [--forbid-path REGEX]...
  rewrite.py pins    --repo DIR --tip REF        (the gitlinks in its history)
  rewrite.py --self-test

rewrite builds a second history from the commits reachable from the tips and
not from any --keep ref (upstream's commits in the fork, which stay as they
are). Each such commit gets the same tree and the same times, but:

- author and committer become --identity, and the time zone +0000;
- trailers that name a person (Co-Authored-By, Signed-off-by, any "-by", Cc)
  are dropped, unless their address is a --tool-address;
- signatures and merged tag headers are dropped (they would not verify, and a
  tag header names its tagger), and so is any header git does not define for
  a commit;
- a commit ID quoted in the message that is the start of a rewritten commit's
  ID, or of one in --gitlink-map, becomes the start of the new ID, with the
  same length;
- with --gitlink-map, every submodule pin (a gitlink) in its tree, or only
  those at a --gitlink-path, is replaced through the map. A pin that is not in the map must be a commit of the
  submodule's --gitlink-keep refs (upstream), or the rewrite stops.

- with --exclude, every file or pin whose path matches one of the patterns
  (Python regexes, searched in the path from the top of the tree) is left
  out, and a folder left empty goes with it; a commit that then changes
  nothing drops out, and whatever named it (a child, a pin, the map) names its
  parent instead. A commit that already changed nothing stays;
- with --replace OLD NEW (literal) and --replace-regex PATTERN NEW, every
  text file of its tree, and its message, has OLD replaced by NEW (the
  forge's address by GitHub's, a home folder by a neutral one);
- with --put NAME=PATH, a commit whose tree has the file PATH also gets it as
  NAME at the top (the mirror's own README, kept in the tree elsewhere).

Nothing but the commits themselves goes in: rewriting the same history again
gives the same IDs, so a mirror grows by ordinary pushes. The first --tip's
new commit is stored at --out-ref, the others' at --out-ref/<n>; --map gets
one "old new" line per rewritten commit.

check reads the rewritten commits back without trusting rewrite: each one
reachable from a --tip and not from a --keep ref must have --identity as
author and committer with +0000, no signature, no trailer naming a person,
and neither its message nor any file it brings in (any blob reachable from
the tips and not from the keep refs) may contain an identity. The identities
are the addresses of the --original commits' authors and committers and of
the trailers rewrite would drop (and the part before the @ when it is at least
six characters and not a generic word), plus one per line of the environment
variable --identities-env names (a secret: names, handles, other addresses),
plus those of --identities-file (one per line, as --save-identities writes
the list a check used, so that a second repository's check covers the first's
people too).
The matching is case-insensitive. So is a --forbid-text (a literal: the
forge's address, which must not be written into this file either); a
--forbid-regex is not. A path matching a --forbid-path pattern
(Python regex, searched) fails too. Findings name the commit or the path and
the number of the identity in that list, never the identity itself.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

DEFAULT_IDENTITY = "n-ga.ge contributors <contributors@n-ga.ge>"
DEFAULT_TOOL_ADDRESSES = ["noreply@anthropic.com"]
# Headers a commit object may carry that are kept; everything else is dropped.
KEPT_HEADERS = {b"tree", b"parent", b"author", b"committer", b"encoding"}
PERSON_RE = re.compile(rb"^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$")
TRAILER_RE = re.compile(rb"^\s*([A-Za-z][A-Za-z0-9-]*)\s*:(.*)$")
ADDRESS_RE = re.compile(rb"<([^<>\s]+@[^<>\s]+)>")
HEX_RE = re.compile(rb"(?<![0-9A-Za-z])[0-9a-f]{7,64}(?![0-9A-Za-z])")
# What a credential looks like. A match whose text says it is an example or
# made up for a test is let through (AWS's documented example key, the tests'
# own tokens).
TOKEN_PATTERNS = [
    ("a GitHub token", rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})"),
    ("a private key", rb"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----"),
    ("an AWS access key", rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("a Slack token", rb"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    ("an Anthropic key", rb"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    ("a Google API key", rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("a credential assignment", rb"(?i)\b(?:token|secret|password|passwd|api[_-]?key)[A-Za-z_]*\s*[:=]\s*[\"']?[A-Za-z0-9/+_.-]{24,}"),
]
TOKEN_RES = [(what, re.compile(p)) for what, p in TOKEN_PATTERNS]
HARMLESS_RE = re.compile(rb"(?i)example|made-up|for-the-test|test-token|dummy|fake|local-dev|placeholder|x{8}|0123456789|abcdef012345")


def token_findings(data):
    out = []
    for what, r in TOKEN_RES:
        for m in r.finditer(data):
            if not HARMLESS_RE.search(m.group(0)):
                out.append(what)
                break
    return out


GENERIC_LOCAL_PARTS = {"noreply", "no-reply", "contributors", "contact", "admin",
                       "github", "gitlab", "forgejo", "git", "info", "users",
                       "actions", "runner", "bot"}


def fail(msg):
    print(f"rewrite.py: {msg}", file=sys.stderr)
    sys.exit(1)


class Git:
    """One repository: plain commands, a cat-file --batch reader, a writer."""

    def __init__(self, repo):
        self.repo = repo
        self.env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1", LC_ALL="C")
        self._cat = None

    def run(self, *args, data=None, check=True):
        p = subprocess.run(["git", "-C", self.repo, *args], input=data,
                           capture_output=True, env=self.env)
        if check and p.returncode:
            fail(f"git {' '.join(args)} in {self.repo}: "
                 f"{p.stderr.decode(errors='replace').strip()}")
        return p.stdout

    def ok(self, *args):
        return subprocess.run(["git", "-C", self.repo, *args], capture_output=True,
                              env=self.env).returncode == 0

    def rev(self, ref):
        return self.run("rev-parse", "--verify", "--end-of-options",
                        ref + "^{commit}").decode().strip()

    def read(self, oid):
        if self._cat is None:
            self._cat = subprocess.Popen(["git", "-C", self.repo, "cat-file", "--batch"],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         env=self.env)
        self._cat.stdin.write(oid.encode() + b"\n")
        self._cat.stdin.flush()
        header = self._cat.stdout.readline().split()
        if len(header) < 3:
            return None, None
        size = int(header[2])
        data = self._cat.stdout.read(size)
        self._cat.stdout.read(1)
        return header[1].decode(), data

    def write(self, kind, data):
        return self.run("hash-object", "-w", "-t", kind, "--stdin", data=data).decode().strip()

    def rev_list(self, tips, keep, *extra):
        args = ["rev-list", *extra, *tips] + ["^" + k for k in keep]
        return self.run(*args).decode().split("\n")[:-1] if tips else []

    def close(self):
        if self._cat:
            self._cat.stdin.close()
            self._cat.wait()


def parse_commit(data):
    head, sep, message = data.partition(b"\n\n")
    headers = []
    for line in head.split(b"\n"):
        if line.startswith(b" ") and headers:
            key, value = headers[-1]
            headers[-1] = (key, value + b"\n" + line)
        else:
            key, _, value = line.partition(b" ")
            headers.append((key, value))
    return headers, message


def is_person_trailer(key):
    k = key.lower()
    return k.endswith(b"-by") or k == b"cc"


def tool_trailer(line, tools):
    """For a trailer line naming a person: True when its address is a tool's."""
    addresses = [a.decode(errors="replace").lower() for a in ADDRESS_RE.findall(line)]
    return bool(addresses) and all(a in tools for a in addresses)


def trailer_addresses(message, tools):
    """Addresses in the person trailers of a message that are not tools'."""
    out = set()
    for line in message.split(b"\n"):
        m = TRAILER_RE.match(line)
        if m and is_person_trailer(m.group(1)):
            for a in ADDRESS_RE.findall(line):
                a = a.decode(errors="replace").lower()
                if a not in tools:
                    out.add(a)
    return out


class Rewriter:
    def __init__(self, git, identity, tools, gitlink_map=None, gitlink_check=None, exclude=(),
                 put=(), gitlink_paths=(), replace=()):
        m = re.fullmatch(r"(.+) <([^<>\s]+)>", identity)
        if not m:
            fail(f"--identity must look like 'Name <address>', not {identity!r}")
        self.ident = (m.group(1).encode(), m.group(2).encode())
        self.git = git
        self.tools = {t.lower() for t in tools}
        self.map = {}                       # old commit -> new commit
        self.gitlink_map = gitlink_map or {}
        self.gitlink_check = gitlink_check  # oid -> True when the pin may stay
        self.exclude = [re.compile(p) for p in exclude]
        self.gitlink_paths = set(gitlink_paths)
        # (compiled pattern, replacement): literal pairs and regex pairs alike
        self.replace = [(re.compile(re.escape(o.encode())), n.encode().replace(b"\\", b"\\\\"))
                        for o, n in replace.get("literal", [])] + \
                       [(re.compile(o.encode()), n.encode()) for o, n in replace.get("regex", [])] \
            if replace else []
        self.blobs = {}                     # old blob -> new blob
        self.put = [tuple(x.split("=", 1)) for x in put]   # (top-level name, path it comes from)
        for dst, src in self.put:
            if "/" in dst or not src:
                fail(f"--put takes NAME=PATH with NAME at the top level, not {dst}={src}")
        self.trees = {}                     # (old tree, path) -> new tree
        self.commit_trees = {}              # commit -> its tree
        self.stats = dict(commits=0, dropped=0, identities=set(), trailers_dropped=0,
                          trailers_kept=0, headers_dropped=0, ids_replaced=0,
                          pins_mapped=0, pins_kept=0, zones=0, paths_excluded=set(), put=0,
                          files_replaced=0)
        self.unmapped_pins = []

    # -- trees ---------------------------------------------------------------
    def excluded(self, path):
        return any(p.search(path) for p in self.exclude)

    def tree(self, oid, path=""):
        """The tree with excluded paths left out and pins mapped, or None when nothing is left."""
        if (not self.gitlink_map and self.gitlink_check is None and not self.exclude and not self.put
                and not self.replace):
            return oid
        key = (oid, path)
        if key in self.trees:
            return self.trees[key]
        kind, data = self.git.read(oid)
        if kind != "tree":
            fail(f"tree {oid} is missing")
        entries = []
        changed = False
        i = 0
        n = len(bytes.fromhex(oid))
        while i < len(data):
            sp = data.index(b" ", i)
            nul = data.index(b"\0", sp)
            mode, name = data[i:sp], data[sp + 1:nul]
            entry = data[nul + 1:nul + 1 + n].hex()
            i = nul + 1 + n
            full = path + name.decode("utf-8", errors="surrogateescape")
            if mode == b"40000":
                full += "/"
            # Patterns are tried on files and pins only: a folder goes when
            # nothing in it is left.
            elif self.excluded(full):
                self.stats["paths_excluded"].add(full)
                changed = True
                continue
            new = entry
            if mode == b"40000":
                new = self.tree(entry, full)
            elif mode == b"160000":
                new = self.pin(entry, full)
            elif self.replace and mode in (b"100644", b"100755"):
                new = self.blob(entry)
            if new is None:                 # a folder that held only excluded paths
                changed = True
                continue
            changed |= new != entry
            entries.append((mode, name, new))
        if not path and self.put:
            for dst, src in self.put:
                line = self.git.run("ls-tree", "--full-tree", oid, "--", src).decode().split()
                if len(line) >= 3 and line[1] == "blob":
                    entries = [e for e in entries if e[1] != dst.encode()]
                    entries.append((line[0].encode(), dst.encode(), line[2]))
                    self.stats["put"] += 1
                    changed = True
        # git's order: by name, a folder's name as if it ended in "/"
        entries.sort(key=lambda e: e[1] + (b"/" if e[0] == b"40000" else b""))
        out = b"".join(m + b" " + n + b"\0" + bytes.fromhex(o) for m, n, o in entries)
        if not changed:
            result = oid
        elif out or not path:
            result = self.git.write("tree", out)
        else:
            result = None
        self.trees[key] = result
        return result

    def text(self, data):
        for pattern, new in self.replace:
            data = pattern.sub(new, data)
        return data

    def blob(self, oid):
        """A file with the --replace rules applied (text files only)."""
        if oid not in self.blobs:
            _, data = self.git.read(oid)
            new = oid
            if b"\0" not in data[:8000]:
                out = self.text(data)
                if out != data:
                    new = self.git.write("blob", out)
                    self.stats["files_replaced"] += 1
            self.blobs[oid] = new
        return self.blobs[oid]

    def tree_of(self, commit):
        if commit not in self.commit_trees:
            self.commit_trees[commit] = self.git.run("rev-parse", commit + "^{tree}").decode().strip()
        return self.commit_trees[commit]

    def pin(self, oid, path):
        if self.gitlink_check is None or (self.gitlink_paths and path not in self.gitlink_paths):
            return oid                      # not a pin this rewrite maps
        if oid in self.gitlink_map:
            self.stats["pins_mapped"] += 1
            return self.gitlink_map[oid]
        if self.gitlink_check is not None and self.gitlink_check(oid):
            self.stats["pins_kept"] += 1
            return oid
        self.unmapped_pins.append((path, oid))
        return oid

    # -- messages ------------------------------------------------------------
    def resolve(self, token):
        t = token.decode()
        hits = set()
        for table in (self.map, self.gitlink_map):
            if t in table:
                hits.add(table[t])
            elif len(t) < 40:
                hits.update(new for old, new in table.items() if old.startswith(t))
        if len(hits) == 1:
            self.stats["ids_replaced"] += 1
            return hits.pop()[:len(t)].encode()
        return token

    def message(self, message):
        lines = []
        for line in message.split(b"\n"):
            m = TRAILER_RE.match(line)
            if m and is_person_trailer(m.group(1)):
                if tool_trailer(line, self.tools):
                    self.stats["trailers_kept"] += 1
                else:
                    self.stats["trailers_dropped"] += 1
                    continue
            lines.append(line)
        out = b"\n".join(lines)
        if message.endswith(b"\n"):
            out = out.rstrip(b"\n") + b"\n"
        return HEX_RE.sub(lambda m: self.resolve(m.group(0)), self.text(out))

    # -- commits -------------------------------------------------------------
    def person(self, value, role):
        m = PERSON_RE.match(value)
        if not m:
            fail(f"cannot read the {role} line {value!r}")
        self.stats["identities"].add(m.group(2).lower())
        if m.group(4) != b"+0000":
            self.stats["zones"] += 1
        return self.ident[0] + b" <" + self.ident[1] + b"> " + m.group(3) + b" +0000"

    def commit(self, old):
        kind, data = self.git.read(old)
        if kind != "commit":
            fail(f"commit {old} is missing")
        headers, message = parse_commit(data)
        self.unmapped_pins = []
        tree, parents, rest, old_tree, old_parents = None, [], [], None, []
        for key, value in headers:
            if key == b"tree":
                old_tree = value.decode()
                tree = self.tree(old_tree)
            elif key == b"parent":
                old_parents.append(value.decode())
                p = self.map.get(value.decode(), value.decode())
                if p not in parents:        # two parents can become one when commits drop out
                    parents.append(p)
            elif key in (b"author", b"committer"):
                rest.append(key + b" " + self.person(value, key.decode()))
            elif key in KEPT_HEADERS:
                rest.append(key + b" " + value)
            else:
                self.stats["headers_dropped"] += 1
        if self.unmapped_pins:
            path, oid = self.unmapped_pins[0]
            fail(f"commit {old} pins {path} at {oid}, which is neither a rewritten commit of "
                 f"that repository nor one of its kept (upstream) commits. The fork must still "
                 f"have it (docs/mirror.md, 'Rebasing the fork').")
        # A commit that changed nothing but excluded paths drops out; whatever
        # pointed at it points at its parent. (One that changed nothing at all
        # on the forge stays.)
        if (len(parents) == 1 and self.exclude and tree == self.tree_of(parents[0]) and
                not (len(old_parents) == 1 and old_tree == self.tree_of(old_parents[0]))):
            self.map[old] = parents[0]
            self.stats["dropped"] += 1
            return parents[0]
        out = [b"tree " + tree.encode()] + [b"parent " + p.encode() for p in parents] + rest
        new = self.git.write("commit", b"\n".join(out) + b"\n\n" + self.message(message))
        self.map[old] = new
        self.commit_trees[new] = tree
        self.stats["commits"] += 1
        return new

    def run(self, tips, keep):
        todo = self.git.rev_list(tips, keep, "--topo-order", "--reverse")
        for old in todo:
            self.commit(old)
        return [self.map.get(t, t) for t in tips]


def read_map(path):
    out = {}
    with open(path) as f:
        for line in f:
            if line.strip():
                old, new = line.split()
                out[old] = new
    return out


def cmd_rewrite(a):
    git = Git(a.repo)
    tips = [git.rev(t) for t in a.tip]
    keep = [git.rev(k) for k in a.keep]
    gitlink_map, check = None, None
    if a.gitlink_map:
        gitlink_map = read_map(a.gitlink_map)
        sub = Git(a.gitlink_repo) if a.gitlink_repo else None
        sub_keep = [sub.rev(k) for k in a.gitlink_keep] if sub else []

        def check(oid):
            return sub is not None and any(
                sub.ok("merge-base", "--is-ancestor", oid, k) for k in sub_keep)
    rw = Rewriter(git, a.identity, a.tool_address or DEFAULT_TOOL_ADDRESSES, gitlink_map, check,
                  a.exclude, a.put, a.gitlink_path,
                  {"literal": a.replace or [], "regex": a.replace_regex or []})
    new_tips = rw.run(tips, keep)
    for i, new in enumerate(new_tips):
        git.run("update-ref", a.out_ref if i == 0 else f"{a.out_ref}/{i}", new)
    with open(a.map, "w") as f:
        for old, new in rw.map.items():
            f.write(f"{old} {new}\n")
    s = rw.stats
    print(f"rewrote {s['commits']} commits of {a.repo}; "
          f"{s['dropped']} commits that changed only excluded paths dropped; "
          f"{len(s['identities'])} distinct identities replaced; "
          f"{s['zones']} time zones moved to UTC; "
          f"{s['trailers_dropped']} trailers naming a person dropped, {s['trailers_kept']} naming a tool kept; "
          f"{s['headers_dropped']} signature or other headers dropped; "
          f"{s['ids_replaced']} commit IDs in messages replaced; "
          f"{s['pins_mapped']} submodule pins mapped, {s['pins_kept']} left on upstream commits; "
          f"{s['put']} trees given a file by --put; "
          f"{s['files_replaced']} file versions changed by --replace")
    for t, n in zip(a.tip, new_tips):
        print(f"  {t} -> {n}")
    if s["paths_excluded"]:
        tops = sorted({re.sub(r"^((?:[^/]*/){0,1}[^/]*/?).*", r"\1", x) for x in s["paths_excluded"]})
        print(f"  {len(s['paths_excluded'])} excluded paths, under: {' '.join(tops)}")
    git.close()


def cmd_pins(a):
    git = Git(a.repo)
    seen_trees, pins = set(), set()

    def walk(oid):
        if oid in seen_trees:
            return
        seen_trees.add(oid)
        _, data = git.read(oid)
        i, n = 0, len(bytes.fromhex(oid))
        while i < len(data):
            sp = data.index(b" ", i)
            nul = data.index(b"\0", sp)
            mode, entry = data[i:sp], data[nul + 1:nul + 1 + n].hex()
            i = nul + 1 + n
            if mode == b"40000":
                walk(entry)
            elif mode == b"160000":
                pins.add(entry)
    for tree in set(git.run("log", "--format=%T", git.rev(a.tip)).decode().split()):
        walk(tree)
    for p in sorted(pins):
        print(p)
    git.close()


def identities_from(git, originals, keep, tools, env_name):
    found = set()
    for line in git.run("log", "--format=%ae%n%ce", *originals, *["^" + k for k in keep]).decode().split("\n"):
        if line.strip():
            found.add(line.strip().lower())
    for c in git.rev_list(originals, keep):
        _, data = git.read(c)
        found |= trailer_addresses(parse_commit(data)[1], tools)
    found -= tools
    needles = set(found)
    for addr in found:
        local = addr.split("@")[0]
        if len(local) >= 6 and local not in GENERIC_LOCAL_PARTS:
            needles.add(local)
    if env_name and os.environ.get(env_name):
        for line in os.environ[env_name].split("\n"):
            line = line.strip()
            if line and not line.startswith("#"):
                needles.add(line.lower())
    # A stable numbering that does not depend on set order.
    return sorted(needles, key=lambda s: (len(s), s))


def cmd_check(a):
    git = Git(a.repo)
    tools = {t.lower() for t in (a.tool_address or DEFAULT_TOOL_ADDRESSES)}
    keep = [git.rev(k) for k in a.keep]
    originals = [git.rev(o) for o in a.original]
    tips = [git.rev(t) for t in a.tip]
    ident = a.identity.encode()
    needles = identities_from(git, originals, keep, tools, a.identities_env)
    if a.identities_file:
        with open(a.identities_file) as f:
            needles = sorted(set(needles) | {l.strip() for l in f if l.strip()}, key=lambda s: (len(s), s))
    if a.save_identities:
        with open(a.save_identities, "w") as f:
            f.writelines(n + "\n" for n in needles)
    raw = [n.encode() for n in needles]
    secrets = []
    for name in a.secret_env:
        value = os.environ.get(name, "").strip()
        if len(value) >= 8:
            secrets.append((name, value.encode()))
    forbid = [re.compile(p) for p in a.forbid_path]
    texts = [t.lower().encode() for t in a.forbid_text]
    text_res = [re.compile(p.encode()) for p in a.forbid_regex]
    problems = []

    def search(data, where):
        low = data.lower()
        for i, n in enumerate(raw):
            if n in low:
                problems.append(f"{where}: contains identity no. {i + 1}")
        for name, value in secrets:
            if value in data:
                problems.append(f"{where}: contains the value of {name}")
        for i, t in enumerate(texts):
            if t in low:
                problems.append(f"{where}: contains forbidden text no. {i + 1}")
        for i, t in enumerate(text_res):
            if t.search(data):
                problems.append(f"{where}: matches forbidden pattern no. {i + 1}")
        if b"\0" not in data[:8000]:
            for what in token_findings(data):
                problems.append(f"{where}: contains what looks like {what}")

    commits = git.rev_list(tips, keep)
    for c in commits:
        _, data = git.read(c)
        headers, message = parse_commit(data)
        for key, value in headers:
            if key in (b"author", b"committer"):
                m = PERSON_RE.match(value)
                if not m or m.group(1) + b" <" + m.group(2) + b">" != ident:
                    problems.append(f"commit {c}: the {key.decode()} is not the project identity")
                elif m.group(4) != b"+0000":
                    problems.append(f"commit {c}: the {key.decode()}'s time zone is not +0000")
            elif key not in KEPT_HEADERS:
                problems.append(f"commit {c}: has a {key.decode(errors='replace')} header")
        for line in message.split(b"\n"):
            m = TRAILER_RE.match(line)
            if m and is_person_trailer(m.group(1)) and not tool_trailer(line, tools):
                problems.append(f"commit {c}: a {m.group(1).decode(errors='replace')} trailer names a person")
        search(message, f"commit {c}: the message")
    # Paths: every path a rewritten commit changes, and every path of each tip.
    paths = set(git.run("log", "--format=", "--name-only", "--no-renames", "-m", "--root",
                        *tips, *["^" + k for k in keep]).decode().split("\n"))
    for t in tips:
        paths |= set(git.run("ls-tree", "-r", "--name-only", "--full-tree", t).decode().split("\n"))
    paths.discard("")
    for path in sorted(paths):
        for p in forbid:
            if p.search(path):
                problems.append(f"path {path}: matches the forbidden pattern {p.pattern!r}")
    blobs = 0
    for line in git.run("rev-list", "--objects", *tips, *["^" + k for k in keep]).decode().split("\n"):
        oid, _, path = line.partition(" ")
        if not oid or not path:
            continue
        kind, data = git.read(oid)
        if kind != "blob":
            continue
        blobs += 1
        search(data, f"file {path} (blob {oid[:12]})")
    git.close()
    print(f"checked {len(commits)} commits, {len(paths)} paths and {blobs} files of {a.repo} "
          f"against {len(needles)} identities, {len(secrets)} secret values, "
          f"{len(texts) + len(text_res)} forbidden texts and "
          f"{len(TOKEN_RES)} token patterns: {len(problems)} problems")
    for p in problems[:200]:
        print("  " + p)
    if problems:
        sys.exit(1)


# -- self-test -----------------------------------------------------------------

def self_test():
    tmp = tempfile.mkdtemp(prefix="mirror-selftest-")
    env = dict(os.environ, HOME=tmp, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_NO_REPLACE_OBJECTS="1")
    for k in list(env):
        if k.startswith("GIT_") and k not in ("GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL",
                                               "GIT_NO_REPLACE_OBJECTS"):
            del env[k]
    me = os.path.abspath(__file__)

    def git(repo, *args, who=("Up Stream", "up@example.org"), when="1700000000 +0300", data=None):
        e = dict(env, GIT_AUTHOR_NAME=who[0], GIT_AUTHOR_EMAIL=who[1], GIT_AUTHOR_DATE=when,
                 GIT_COMMITTER_NAME=who[0], GIT_COMMITTER_EMAIL=who[1], GIT_COMMITTER_DATE=when)
        p = subprocess.run(["git", "-C", repo, *args], input=data, capture_output=True, env=e)
        if p.returncode:
            raise AssertionError(f"git {args}: {p.stderr.decode()}")
        return p.stdout.decode().strip()

    def tool(*args, ok=True):
        p = subprocess.run([sys.executable, "-I", me, *args], capture_output=True, env=env)
        out = (p.stdout + p.stderr).decode()
        if (p.returncode == 0) != ok:
            raise AssertionError(f"rewrite.py {' '.join(args)} gave {p.returncode}:\n{out}")
        return out

    def commit_file(repo, name, text, msg, who, when):
        with open(os.path.join(repo, name), "w") as f:
            f.write(text)
        git(repo, "add", name)
        git(repo, "commit", "-q", "-m", msg, who=who, when=when)
        return git(repo, "rev-parse", "HEAD")

    alice = ("Alice Person", "alice.person@example.com")
    forge = ("Merge Bot", "merger@forge.example")
    try:
        # upstream: public history that must stay as it is
        up = os.path.join(tmp, "up")
        os.mkdir(up)
        git(up, "init", "-q", "-b", "master")
        commit_file(up, "a.txt", "one\n", "Upstream one", ("Up Stream", "up@example.org"), "1700000000 +0300")
        up_tip = commit_file(up, "a.txt", "two\n", "Upstream two", ("Up Stream", "up@example.org"), "1700000100 +0300")

        # the fork: port commits on top, a side branch merged, a signed commit
        fork = os.path.join(tmp, "fork")
        git(tmp, "clone", "-q", up, fork)
        git(fork, "checkout", "-q", "-b", "web-port")
        a = commit_file(fork, "web.txt", "port\n",
                        "web: port\n\nCo-Authored-By: Bob Person <bob@example.com>\n"
                        "Co-Authored-By: Tool <noreply@tool.example>\nSigned-off-by: Alice Person <alice.person@example.com>\n",
                        alice, "1700001000 +0200")
        b = commit_file(fork, "web.txt", "port2\n", f"Revert part\n\nThis reverts commit {a}.\nSee also {a[:9]}.\n",
                        alice, "1700002000 -0500")
        git(fork, "checkout", "-q", "-b", "side")
        side = commit_file(fork, "side.txt", "side\n", "side work", alice, "1700003000 +0200")
        git(fork, "checkout", "-q", "web-port")
        git(fork, "merge", "-q", "--no-ff", "-m", "Merge pull request 'x' (#1) from side into web-port", "side",
            who=forge, when="1700004000 +0200")
        merged = git(fork, "rev-parse", "HEAD")
        # a commit with a signature header, written by hand
        tree = git(fork, "rev-parse", "HEAD^{tree}")
        raw = (f"tree {tree}\nparent {merged}\nauthor Alice Person <alice.person@example.com> 1700005000 +0200\n"
               f"committer Alice Person <alice.person@example.com> 1700005000 +0200\n"
               f"gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nSigned work\n")
        signed = git(fork, "hash-object", "-w", "-t", "commit", "--stdin", data=raw.encode())
        git(fork, "update-ref", "refs/heads/web-port", signed)
        git(fork, "checkout", "-q", "web-port")

        # arcade: pins the fork at several commits, quotes an ID
        arc = os.path.join(tmp, "arcade")
        os.mkdir(arc)
        git(arc, "init", "-q", "-b", "main")
        commit_file(arc, ".gitmodules", '[submodule "eka2l1"]\n\tpath = eka2l1\n\turl = ../EKA2L1.git\n',
                    "Start", alice, "1700000500 +0200")

        def pin(sha, msg, when):
            git(arc, "update-index", "--add", "--cacheinfo", f"160000,{sha},eka2l1")
            git(arc, "commit", "-q", "-m", msg, who=alice, when=when)
            return git(arc, "rev-parse", "HEAD")
        pin(up_tip, "Pin eka2l1 at upstream", "1700000600 +0200")
        pin(a, f"Pin eka2l1 at {a[:10]}", "1700001100 +0200")
        pin(signed, "Pin eka2l1 at the signed one\n\nCo-authored-by: Carol <carol@example.net>\n", "1700006000 +0200")

        def run_mirror(tag):
            """Rewrite fresh copies of fork and arcade; return their new tips and the fork map."""
            f2, a2 = os.path.join(tmp, f"fork-{tag}"), os.path.join(tmp, f"arcade-{tag}")
            git(tmp, "clone", "-q", "--bare", fork, f2)
            git(f2, "fetch", "-q", up, "+master:refs/upstream/master")
            git(tmp, "clone", "-q", "--bare", arc, a2)
            fmap = os.path.join(tmp, f"fork-{tag}.map")
            amap = os.path.join(tmp, f"arcade-{tag}.map")
            tool("rewrite", "--repo", f2, "--tip", "refs/heads/web-port", "--keep", "refs/upstream/master",
                 "--out-ref", "refs/mirror/web-port", "--map", fmap, "--tool-address", "noreply@tool.example")
            tool("rewrite", "--repo", a2, "--tip", "refs/heads/main", "--out-ref", "refs/mirror/main",
                 "--map", amap, "--gitlink-map", fmap, "--gitlink-repo", f2,
                 "--gitlink-keep", "refs/upstream/master", "--gitlink-path", "eka2l1",
                 "--tool-address", "noreply@tool.example")
            return f2, a2, read_map(fmap)

        f2, a2, fmap = run_mirror("1")
        new_fork = git(f2, "rev-parse", "refs/mirror/web-port")
        new_arc = git(a2, "rev-parse", "refs/mirror/main")

        # upstream untouched, every port commit rewritten, trees unchanged
        assert git(f2, "merge-base", "--is-ancestor", up_tip, new_fork) == ""
        assert set(fmap) == {a, b, side, merged, signed}, fmap
        for old, new in fmap.items():
            assert git(f2, "rev-parse", old + "^{tree}") == git(f2, "rev-parse", new + "^{tree}")
            assert git(f2, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%at %ct", new) == \
                f"{DEFAULT_IDENTITY}|{DEFAULT_IDENTITY}|" + git(f2, "log", "-1", "--format=%at %ct", old)
            assert git(f2, "cat-file", "-p", new).count("+0000") == 2
        msg_a = git(f2, "log", "-1", "--format=%B", fmap[a])
        assert "Bob" not in msg_a and "Signed-off-by" not in msg_a, msg_a
        assert "Co-Authored-By: Tool <noreply@tool.example>" in msg_a, msg_a
        msg_b = git(f2, "log", "-1", "--format=%B", fmap[b])
        assert f"reverts commit {fmap[a]}." in msg_b and f"See also {fmap[a][:9]}." in msg_b, msg_b
        assert "gpgsig" not in git(f2, "cat-file", "-p", fmap[signed])
        # arcade: identities replaced, pins mapped, IDs in messages through the fork's map
        assert git(a2, "rev-parse", new_arc + ":eka2l1") == fmap[signed]
        assert git(a2, "rev-parse", new_arc + "~1:eka2l1") == fmap[a]
        assert git(a2, "rev-parse", new_arc + "~2:eka2l1") == up_tip
        assert git(a2, "log", "-1", "--format=%s", new_arc + "~1") == f"Pin eka2l1 at {fmap[a][:10]}"
        assert "Carol" not in git(a2, "log", "-1", "--format=%B", new_arc)
        assert set(git(a2, "log", "--format=%an <%ae>", new_arc).split("\n")) == {DEFAULT_IDENTITY}

        # the same input gives the same IDs, whatever the clock says
        f3, a3, fmap3 = run_mirror("2")
        assert fmap3 == fmap
        assert git(a3, "rev-parse", "refs/mirror/main") == new_arc

        # the check passes on the rewrite and fails on the originals
        common = ["--tool-address", "noreply@tool.example"]
        tool("check", "--repo", f2, "--tip", "refs/mirror/web-port", "--keep", "refs/upstream/master",
             "--original", "refs/heads/web-port", *common)
        tool("check", "--repo", a2, "--tip", "refs/mirror/main", "--original", "refs/heads/main",
             "--forbid-path", r"(?i)(^|/)ngage\.rom$", *common)
        out = tool("check", "--repo", f2, "--tip", "refs/heads/web-port", "--keep", "refs/upstream/master",
                   "--original", "refs/heads/web-port", *common, ok=False)
        assert "is not the project identity" in out and "names a person" in out and "gpgsig" in out, out
        assert "alice" not in out.lower(), out   # findings never print an identity

        # a planted address in a file, a name from the secret in a message, a forbidden path
        commit_file(arc, "notes.md", "ask Alice.Person@Example.com\n", "Notes", alice, "1700007000 +0200")
        f4, a4, _ = run_mirror("3")
        out = tool("check", "--repo", a4, "--tip", "refs/mirror/main", "--original", "refs/heads/main",
                   *common, ok=False)
        assert "file notes.md" in out and "identity no." in out, out
        git(arc, "rm", "-q", "notes.md")
        git(arc, "commit", "-q", "-m", "Thanks to Dora Secret", who=alice, when="1700008000 +0200")
        os.makedirs(os.path.join(arc, "testdata"))
        commit_file(arc, "testdata/NGAGE.ROM", "x\n", "oops", alice, "1700009000 +0200")
        commit_file(arc, "conf.txt", "key = supersecretvalue123\ngh = ghp_" + "a1" * 18 +
                    "\naws = AKIAIOSFODNN7EXAMPLE\ntoken = 'made-up-token-for-the-tests'\n",
                    "Config", alice, "1700009100 +0200")
        f5, a5, _ = run_mirror("4")
        env["MIRROR_TEST_IDS"] = "# comment\nDora Secret\n"
        env["MIRROR_TEST_SECRET"] = "supersecretvalue123"
        out = tool("check", "--repo", a5, "--tip", "refs/mirror/main", "--original", "refs/heads/main",
                   "--identities-env", "MIRROR_TEST_IDS", "--secret-env", "MIRROR_TEST_SECRET",
                   "--forbid-path", r"(?i)(^|/)ngage\.rom$", *common, ok=False)
        assert "the message: contains identity no." in out and "testdata/NGAGE.ROM" in out, out
        assert "file conf.txt" in out and "the value of MIRROR_TEST_SECRET" in out, out
        assert "looks like a GitHub token" in out, out
        assert "AWS" not in out and "credential assignment" not in out, out   # examples and test tokens pass
        assert "dora" not in out.lower() and "supersecret" not in out, out

        # exclusion: private docs and a forge-only folder leave every commit;
        # a commit that changed nothing else drops out, a pin on it moves to its parent
        os.makedirs(os.path.join(fork, ".forgejo"))
        forge_only = commit_file(fork, ".forgejo/README.md", "forge only\n", "Forge readme", alice,
                                 "1700009200 +0200")
        commit_file(arc, "CLAUDE.md", "private guide\n", "Guide", alice, "1700009300 +0200")
        os.makedirs(os.path.join(arc, "docs", "public"))
        commit_file(arc, "docs/ci.md", "internal\n", "Internal docs", alice, "1700009400 +0200")
        commit_file(arc, "README.md", "private readme\n", "Private readme", alice, "1700009410 +0200")
        os.makedirs(os.path.join(arc, "mirror"))
        commit_file(arc, "mirror/README.md", "public readme\n", "Mirror readme", alice, "1700009420 +0200")
        commit_file(arc, "docs/public/index.md", "public\n", "Public docs", alice, "1700009500 +0200")
        pin(forge_only, "Pin at the forge readme", "1700009600 +0200")
        f7, a7 = os.path.join(tmp, "fork-7"), os.path.join(tmp, "arcade-7")
        git(tmp, "clone", "-q", "--bare", fork, f7)
        git(f7, "fetch", "-q", up, "+master:refs/upstream/master")
        git(tmp, "clone", "-q", "--bare", arc, a7)
        tool("rewrite", "--repo", f7, "--tip", "refs/heads/web-port", "--keep", "refs/upstream/master",
             "--out-ref", "refs/mirror/web-port", "--map", os.path.join(tmp, "f7.map"), "--exclude", r"^\.forgejo/",
             *common)
        fmap7 = read_map(os.path.join(tmp, "f7.map"))
        assert fmap7[forge_only] == fmap7[signed] == fmap[signed], fmap7
        tool("rewrite", "--repo", a7, "--tip", "refs/heads/main", "--out-ref", "refs/mirror/main",
             "--map", os.path.join(tmp, "a7.map"), "--gitlink-map", os.path.join(tmp, "f7.map"),
             "--gitlink-repo", f7, "--gitlink-keep", "refs/upstream/master",
             "--exclude", r"^CLAUDE\.md$", "--exclude", r"^docs/(?!public/)", "--exclude", r"^README\.md$",
             "--put", "README.md=mirror/README.md", *common)
        files = git(a7, "ls-tree", "-r", "--name-only", "refs/mirror/main").split("\n")
        assert "CLAUDE.md" not in files and "docs/ci.md" not in files and "docs/public/index.md" in files, files
        subjects = git(a7, "log", "--format=%s", "refs/mirror/main").split("\n")
        # "Pin at the forge readme" drops out too: its pin moved to the one before
        assert subjects[:3] == ["Public docs", "Mirror readme", "Config"], subjects
        assert git(a7, "cat-file", "-p", "refs/mirror/main:README.md") == "public readme"
        assert git(a7, "rev-parse", "refs/mirror/main:eka2l1") == fmap[signed]
        # the rewrite before the excluded files appeared is the same as without exclusions
        assert git(a7, "rev-parse", "refs/mirror/main~2") == git(a5, "rev-parse", "refs/mirror/main"), \
            git(a7, "log", "--format=%s", "refs/mirror/main")
        out = tool("check", "--repo", a7, "--tip", "refs/heads/main", "--original", "refs/heads/main",
                   "--forbid-path", r"^CLAUDE\.md$", "--forbid-path", r"^docs/(?!public/)", *common, ok=False)
        assert "path CLAUDE.md" in out and "path docs/ci.md" in out and "docs/public" not in out, out

        # the forge's address and a home folder replaced in files and messages
        commit_file(arc, "links.html", '<a href="https://forge.example/org/arcade/src/branch/main/x">src</a>\n'
                    "W=/home/user/work; https://forge.example/org/EKA2L1\n",
                    "Links, see https://forge.example/org/arcade", alice, "1700009700 +0200")
        a8 = os.path.join(tmp, "arcade-8")
        git(tmp, "clone", "-q", "--bare", arc, a8)
        tool("rewrite", "--repo", a8, "--tip", "refs/heads/main", "--out-ref", "refs/mirror/main",
             "--map", os.path.join(tmp, "a8.map"), "--gitlink-map", os.path.join(tmp, "f7.map"),
             "--gitlink-repo", f7, "--gitlink-keep", "refs/upstream/master",
             "--replace", "https://forge.example/org/arcade/src/branch/main/", "https://github.com/o/arcade/blob/main/",
             "--replace", "https://forge.example/org/", "https://github.com/o/",
             "--replace-regex", r"/home/(?!user/)[A-Za-z0-9._-]+/", "/home/user/", *common)
        assert git(a8, "cat-file", "-p", "refs/mirror/main:links.html") == (
            '<a href="https://github.com/o/arcade/blob/main/x">src</a>\n'
            "W=/home/user/work; https://github.com/o/EKA2L1"), git(a8, "cat-file", "-p", "refs/mirror/main:links.html")
        assert git(a8, "log", "-1", "--format=%s", "refs/mirror/main") == "Links, see https://github.com/o/arcade"
        forbid_text = ["--forbid-text", "FORGE.example", "--forbid-regex", r"/home/(?!user/)[A-Za-z0-9._-]+/"]
        out = tool("check", "--repo", a8, "--tip", "refs/heads/main", "--original", "refs/heads/main",
                   *forbid_text, *common, ok=False)
        assert "file links.html" in out and "forbidden text no. 1" in out and "forbidden pattern no. 1" in out, out
        assert "the message: contains forbidden text no. 1" in out and "forge.example" not in out, out
        out = tool("check", "--repo", a8, "--tip", "refs/mirror/main", "--original", "refs/heads/main",
                   *forbid_text, *common, ok=False)   # fails only on the old notes.md and conf.txt
        assert "contains forbidden" not in out and "matches forbidden" not in out, out

        # a pin the fork does not have stops the rewrite
        git(arc, "update-index", "--add", "--cacheinfo", f"160000,{'1' * 40},eka2l1")
        git(arc, "commit", "-q", "-m", "Pin at nothing", who=alice, when="1700010000 +0200")
        f6, a6 = os.path.join(tmp, "fork-5"), os.path.join(tmp, "arcade-5")
        git(tmp, "clone", "-q", "--bare", fork, f6)
        git(f6, "fetch", "-q", up, "+master:refs/upstream/master")
        git(tmp, "clone", "-q", "--bare", arc, a6)
        tool("rewrite", "--repo", f6, "--tip", "refs/heads/web-port", "--keep", "refs/upstream/master",
             "--out-ref", "refs/mirror/web-port", "--map", os.path.join(tmp, "f6.map"))
        out = tool("rewrite", "--repo", a6, "--tip", "refs/heads/main", "--out-ref", "refs/mirror/main",
                   "--map", os.path.join(tmp, "a6.map"), "--gitlink-map", os.path.join(tmp, "f6.map"),
                   "--gitlink-repo", f6, "--gitlink-keep", "refs/upstream/master", ok=False)
        assert "pins eka2l1 at " + "1" * 40 in out, out

        # pins lists the gitlinks of a history
        pins = tool("pins", "--repo", arc, "--tip", "main").split()
        assert set(pins) == {up_tip, a, signed, forge_only, "1" * 40}, pins
        print("rewrite.py self-test: ok")
    finally:
        if not os.environ.get("MIRROR_SELFTEST_KEEP"): shutil.rmtree(tmp, ignore_errors=True)


def main():
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    p = argparse.ArgumentParser(description="Rewrite a branch for the public mirror, and check it.")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("rewrite")
    r.add_argument("--repo", required=True)
    r.add_argument("--tip", action="append", required=True)
    r.add_argument("--keep", action="append", default=[])
    r.add_argument("--out-ref", required=True)
    r.add_argument("--map", required=True)
    r.add_argument("--gitlink-map")
    r.add_argument("--gitlink-repo")
    r.add_argument("--gitlink-keep", action="append", default=[])
    r.add_argument("--gitlink-path", action="append", default=[])
    r.add_argument("--identity", default=DEFAULT_IDENTITY)
    r.add_argument("--tool-address", action="append")
    r.add_argument("--exclude", action="append", default=[])
    r.add_argument("--put", action="append", default=[])
    r.add_argument("--replace", action="append", nargs=2, metavar=("OLD", "NEW"))
    r.add_argument("--replace-regex", action="append", nargs=2, metavar=("PATTERN", "NEW"))
    c = sub.add_parser("check")
    c.add_argument("--repo", required=True)
    c.add_argument("--tip", action="append", required=True)
    c.add_argument("--keep", action="append", default=[])
    c.add_argument("--original", action="append", required=True)
    c.add_argument("--identity", default=DEFAULT_IDENTITY)
    c.add_argument("--tool-address", action="append")
    c.add_argument("--identities-env")
    c.add_argument("--forbid-path", action="append", default=[])
    c.add_argument("--identities-file")
    c.add_argument("--save-identities")
    c.add_argument("--secret-env", action="append", default=[])
    c.add_argument("--forbid-text", action="append", default=[])
    c.add_argument("--forbid-regex", action="append", default=[])
    q = sub.add_parser("pins")
    q.add_argument("--repo", required=True)
    q.add_argument("--tip", required=True)
    a = p.parse_args()
    {"rewrite": cmd_rewrite, "check": cmd_check, "pins": cmd_pins}[a.cmd](a)


if __name__ == "__main__":
    main()
