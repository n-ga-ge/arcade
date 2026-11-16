#!/usr/bin/env python3
"""Publish the site's documentation: docs/public/*.md as static pages.

  python3 -I tools/site/steps/30-docs.py <dist>        writes <dist>/docs/
  python3 -I tools/site/steps/30-docs.py --self-test   checks the renderer itself

  /docs/            docs/public/index.md, the overview
  /docs/<name>/     docs/public/<name>.md
  /docs/<file>      every other file in docs/public/ (the style sheet, pictures)

Only docs/public/ is published. It is the general description for visitors:
what the site is and how to play. README.md and the other pages in docs/ are
for people working on the code and are read in the repository.

The pages are listed in the order the overview first links to them, so it
must link to every page in docs/public/.

Links are written the way the forge wants them (relative to the Markdown file)
and are rewritten here: a link to another page becomes that page's address, a
link to any other file in the repository becomes its address on the forge (the
file must exist and must not be ignored by git), and every "#anchor" is checked
against the headings of the page it points to.

Only the standard library is available, so this renders a subset of Markdown:
headings (# to ####), paragraphs, fenced code blocks, lists (nested, with
paragraphs and code blocks inside items), tables, block quotes, rules, and
inline code, links, images, *emphasis*, **strong**, <https://autolinks> and
backslash escapes. Anything else stops the build with the file and line,
because a page that silently renders differently from the forge, or has a
dead link, is worse than a build that fails.
"""
import html
import os
import posixpath
import re
import shutil
import subprocess
import sys
import unicodedata

# The checkout this script belongs to, not an inherited ARCADE_ROOT: a shell set
# up in another checkout must not make this one publish that one's pages.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# Where the public can read the repository: the pages are for visitors, and
# the forge the project is developed on is private.
FORGE = "https://github.com/n-ga.ge/arcade/blob/main/"
PUBLIC = "docs/public"                    # the folder that is published
HOME = PUBLIC + "/index.md"               # the overview, served at /docs/
SITE_NAME = "n-ga.ge"

PUNCTUATION = set("\\`*_{}[]()#+-.!|<>~\"'&$%,/:;=?@^")
FENCE = re.compile(r"^(`{3,})\s*([A-Za-z0-9_+.-]*)\s*$")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$")
ITEM = re.compile(r"^([-*+]|\d{1,9}[.)])( +)(\S.*)$")
RULE = re.compile(r"^(?:-{3,}|\*{3,}|_{3,})\s*$")
SPACED_RULE = re.compile(r"^([-*_])(?: *\1){2,} *$")
TABLE_RULE = re.compile(r"^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
AUTOLINK = re.compile(r"<((?:https?://|mailto:)[^\s<>]+)>")
DESTINATION = re.compile(r"\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+\"([^\"]*)\")?\s*\)")
ENTITY = re.compile(r"&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);")
BARE_URL = re.compile(r"(?<![\w/])https?://")


class DocsError(Exception):
    pass


def fail(where, message):
    raise DocsError(f"{where}: {message}")


def escape(text):
    return html.escape(text, quote=False)


def attribute(text):
    return html.escape(text, quote=True)


def anchor_id(text):
    """The id the forge gives a heading: lower case, with every run of other
    characters than letters, digits and "_" turned into one hyphen."""
    out = []
    gap = False
    for ch in text.strip():
        if ch == "_" or unicodedata.category(ch)[0] in "LN":
            if gap and out:
                out.append("-")
            gap = False
            out.append(ch.lower())
        else:
            gap = True
    return "".join(out)


def plain(markup):
    """The text of rendered inline markup."""
    return html.unescape(re.sub(r"<[^>]+>", "", markup))


def indent_of(text):
    return len(text) - len(text.lstrip(" "))


def code_span(text, start):
    """(content start, content end, index after the span) for the backtick run
    at `start`, or None when it is never closed."""
    run = 0
    while start + run < len(text) and text[start + run] == "`":
        run += 1
    at = start + run
    while True:
        at = text.find("`", at)
        if at < 0:
            return None
        length = 0
        while at + length < len(text) and text[at + length] == "`":
            length += 1
        if length == run:
            return start + run, at, at + run
        at += length


def repository_files(root):
    """Paths git tracks or would track in the checkout at `root` (ignored files
    left out), or None when `root` is not the top of a git checkout. A link to
    an ignored file would be dead on the forge although the file exists here."""
    try:
        top = subprocess.run(["git", "-C", root, "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
        if os.path.realpath(top) != os.path.realpath(root):
            return None
        listing = subprocess.run(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                                 capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return {path for path in listing.split("\0") if path}


def site_path(asset):
    """Where a file of docs/public/ is served: docs/public/x.svg -> docs/x.svg."""
    return "docs/" + asset[len(PUBLIC) + 1:]


class Page:
    def __init__(self, source):
        self.source = source                      # path in the repository, "/" separated
        name = posixpath.splitext(posixpath.basename(source))[0]
        self.folder = "docs" if source == HOME else "docs/" + name   # folder in the site
        self.title = ""
        self.headings = []                        # (level, id, inline markup)
        self.body = ""
        self.links = []                           # (where, target page, fragment), checked at the end

    def href(self, site_path, folder=False):
        """Relative address of a file or folder of the site, seen from this page."""
        relative = posixpath.relpath(site_path, self.folder)
        if folder:
            return "./" if relative == "." else relative + "/"
        return relative


class Renderer:
    """Renders the Markdown of one page. `pages` maps source path -> Page."""

    def __init__(self, page, pages, root, tracked=None):
        self.page = page
        self.pages = pages
        self.root = root
        self.tracked = tracked                    # see repository_files()
        self.assets = set()                       # files under docs/ the page shows

    # --- links -------------------------------------------------------------

    def link(self, destination, where):
        if destination.startswith("<") and destination.endswith(">"):
            destination = destination[1:-1]
        if not destination:
            fail(where, "a link has no destination")
        if re.match(r"(?:https?://|mailto:)", destination):
            return destination
        if re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", destination):
            fail(where, f"unsupported link scheme in {destination}")
        if destination.startswith("/"):
            fail(where, f"{destination} is relative to the site root and would be dead on the forge: "
                        "link to a file of the repository, or write the path as code")
        path, _, fragment = destination.partition("#")
        if not path:
            self.page.links.append((where, self.page, fragment))
            return "#" + fragment
        target = posixpath.normpath(posixpath.join(posixpath.dirname(self.page.source), path))
        if target.startswith("../") or target == "..":
            fail(where, f"{destination} points outside the repository")
        if target in self.pages:
            other = self.pages[target]
            if fragment:
                self.page.links.append((where, other, fragment))
            return self.page.href(other.folder, folder=True) + ("#" + fragment if fragment else "")
        if target == "eka2l1" or target.startswith("eka2l1/"):
            fail(where, f"{destination} is inside the emulator submodule, which the forge cannot browse from here: "
                        "link to the file in the fork's own repository by URL")
        if target.endswith(".md") and (target.startswith("docs/") or "/" not in target) and not os.path.exists(os.path.join(self.root, target)):
            fail(where, f"{destination}: there is no page {target}")
        if not os.path.exists(os.path.join(self.root, target)):
            fail(where, f"{destination}: there is no {target} in the repository")
        if self.tracked is not None and target not in self.tracked and not any(path.startswith(target + "/") for path in self.tracked):
            fail(where, f"{destination}: {target} is ignored by git, so the link would be dead on the forge")
        return FORGE + target + ("#" + fragment if fragment else "")

    def image(self, source, where):
        if re.match(r"[A-Za-z][A-Za-z0-9+.-]*:|/", source):
            fail(where, f"image {source}: only files in {PUBLIC}/ can be shown (the site loads nothing from elsewhere)")
        target = posixpath.normpath(posixpath.join(posixpath.dirname(self.page.source), source))
        if not target.startswith(PUBLIC + "/") or target.endswith(".md"):
            fail(where, f"image {source}: only files in {PUBLIC}/ are published")
        if not os.path.isfile(os.path.join(self.root, target)):
            fail(where, f"image {source}: there is no {target}")
        self.assets.add(target)
        return self.page.href(site_path(target))

    # --- inline ------------------------------------------------------------

    def closer(self, text, start, mark, run, where):
        """Index of the delimiter run that closes emphasis opened before `start`."""
        at = start
        while at < len(text):
            ch = text[at]
            if ch == "\\":
                at += 2
            elif ch == "`":
                span = code_span(text, at)
                if span is None:
                    fail(where, "a code span is opened with ` but never closed")
                at = span[2]
            elif ch == "]" and text.startswith("](", at):
                match = DESTINATION.match(text, at + 1)
                at = match.end() if match else at + 1
            elif ch == mark:
                length = 0
                while at + length < len(text) and text[at + length] == mark:
                    length += 1
                after = text[at + length] if at + length < len(text) else " "
                if length == run and not text[at - 1].isspace() and not (mark == "_" and after.isalnum()):
                    return at
                at += length
            else:
                at += 1
        return None

    def inline(self, text, where, in_link=False):
        out = []
        at = 0
        size = len(text)
        while at < size:
            ch = text[at]
            before = text[at - 1] if at else " "
            if ch == "\\":
                if at + 1 < size and text[at + 1] in PUNCTUATION:
                    out.append(escape(text[at + 1]))
                    at += 2
                elif at + 1 < size and text[at + 1] == "\n":
                    out.append("<br>\n")
                    at += 2
                else:
                    out.append("\\")
                    at += 1
            elif ch == "`":
                span = code_span(text, at)
                if span is None:
                    fail(where, "a code span is opened with ` but never closed")
                content = text[span[0]:span[1]].replace("\n", " ")
                if len(content) > 1 and content[0] == " " and content[-1] == " " and content.strip():
                    content = content[1:-1]
                out.append(f"<code>{escape(content)}</code>")
                at = span[2]
            elif ch == "!" and text.startswith("![", at):
                end = self.bracket(text, at + 1)
                match = DESTINATION.match(text, end + 1) if end is not None else None
                if not match:
                    fail(where, "malformed image: write ![description](file)")
                alt = plain(self.inline(text[at + 2:end], where, in_link=True))
                out.append(f'<img src="{attribute(self.image(match.group(1), where))}" alt="{attribute(alt)}">')
                at = match.end()
            elif ch == "[":
                end = self.bracket(text, at)
                following = text[end + 1] if end is not None and end + 1 < size else ""
                label = text[at + 1:end] if end is not None else ""
                if label.startswith("^"):
                    fail(where, "footnotes are not supported")
                if following == "[" or (following == ":" and at == 0):
                    fail(where, "reference-style links are not supported: write [text](destination)")
                if following == "(":
                    match = DESTINATION.match(text, end + 1)
                    if not match:
                        fail(where, f"malformed link after [{label}]")
                    if in_link:
                        fail(where, "a link inside a link")
                    title = f' title="{attribute(match.group(2))}"' if match.group(2) else ""
                    out.append(f'<a href="{attribute(self.link(match.group(1), where))}"{title}>{self.inline(label, where, in_link=True)}</a>')
                    at = match.end()
                else:
                    out.append("[")
                    at += 1
            elif ch == "<":
                match = AUTOLINK.match(text, at)
                if match:
                    if in_link:
                        fail(where, "a link inside a link")
                    out.append(f'<a href="{attribute(match.group(1))}">{escape(match.group(1))}</a>')
                    at = match.end()
                elif re.match(r"</?[A-Za-z!]", text[at:]):
                    fail(where, "raw HTML is not supported (write \\< for a literal <, or put it in a code span)")
                else:
                    out.append("&lt;")
                    at += 1
            elif ch in "*_":
                run = 0
                while at + run < size and text[at + run] == ch:
                    run += 1
                after = text[at + run] if at + run < size else " "
                opens = not after.isspace() and not (ch == "_" and before.isalnum())
                if not opens:
                    if ch == "*" and not before.isspace():
                        fail(where, "a * closes emphasis that was never opened (write \\* for a literal *)")
                    out.append(ch * run)
                    at += run
                    continue
                if run > 2:
                    fail(where, f"{ch * run} is not supported: use * for emphasis and ** for strong")
                end = self.closer(text, at + run, ch, run, where)
                if end is None:
                    fail(where, f"{ch * run} opens emphasis that is never closed (write \\{ch} for a literal {ch})")
                tag = "em" if run == 1 else "strong"
                out.append(f"<{tag}>{self.inline(text[at + run:end], where, in_link)}</{tag}>")
                at = end + run
            elif ch == "&":
                if ENTITY.match(text, at):
                    fail(where, "HTML entities are not supported: write the character itself")
                out.append("&amp;")
                at += 1
            elif ch == "~" and text.startswith("~~", at):
                fail(where, "~~strikethrough~~ is not supported")
            elif ch == "h" and not in_link and BARE_URL.match(text, at):
                fail(where, "a bare URL: write <https://...> or [text](https://...)")
            else:
                out.append(escape(ch))
                at += 1
        return "".join(out)

    def bracket(self, text, start):
        """Index of the ] that closes the [ at `start`, or None."""
        depth = 0
        at = start
        while at < len(text):
            ch = text[at]
            if ch == "\\":
                at += 2
                continue
            if ch == "`":
                span = code_span(text, at)
                at = span[2] if span else at + 1
                continue
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    return at
            at += 1
        return None

    # --- blocks ------------------------------------------------------------

    def where(self, number):
        return f"{self.page.source}:{number}"

    def starts_block(self, text):
        """Does this line begin something that ends the paragraph before it?"""
        item = ITEM.match(text)
        return bool(FENCE.match(text) or text.startswith("~~~") or HEADING.match(text) or text.startswith(">")
                    or re.match(r"^(?:\*{3,}|_{3,})\s*$", text)
                    or (item and (not item.group(1)[0].isdigit() or item.group(1)[:-1] == "1")))

    def blocks(self, lines, top=False):
        """lines: [(line number, text)] with the container's indentation removed.
        Returns [(kind, markup, gap)]; gap says a blank line separates the block
        from the one before it, which is what makes a list loose."""
        out = []      # (kind, markup): every pass of the loop below adds exactly one
        gaps = []     # for each of them, whether blank lines came before it
        at = 0
        count = len(lines)
        blank = False
        while at < count:
            number, text = lines[at]
            where = self.where(number)
            if not text.strip():
                at += 1
                blank = True
                continue
            gaps.append(blank and bool(out))
            blank = False
            if SPACED_RULE.match(text) and not RULE.match(text):
                fail(where, "a rule written with spaces: write ---")
            if "\t" in text:
                fail(where, "a tab character: indent with spaces")
            if text.startswith(" "):
                fail(where, "unexpected indentation (an indented code block? use a ``` fence)")

            fence = FENCE.match(text)
            if fence:
                closing = at + 1
                while closing < count and lines[closing][1].rstrip() != fence.group(1):
                    closing += 1
                if closing == count:
                    fail(where, "a ``` code block is never closed")
                code = "\n".join(line for _, line in lines[at + 1:closing])
                language = f' class="language-{attribute(fence.group(2))}"' if fence.group(2) else ""
                out.append(("code", f"<pre><code{language}>{escape(code)}\n</code></pre>"))
                at = closing + 1
                continue
            if text.startswith("```") or text.startswith("~~~"):
                fail(where, "unsupported code fence: use ``` with an optional language name")

            heading = HEADING.match(text)
            if heading:
                level = len(heading.group(1))
                if level > 4:
                    fail(where, "headings deeper than #### are not supported")
                if not top:
                    fail(where, "a heading inside a list or a quote")
                if BARE_URL.search(heading.group(2)) or "](" in heading.group(2):
                    fail(where, "a link in a heading")
                markup = self.inline(heading.group(2), where, in_link=True)
                label = plain(markup)
                ident = anchor_id(label)
                if not ident:
                    fail(where, "a heading needs some text")
                if any(ident == existing for _, existing, _ in self.page.headings):
                    fail(where, f'two headings on this page would share the anchor "#{ident}"')
                if level == 1:
                    if self.page.headings:
                        fail(where, "a page has one # title, and it comes first")
                    self.page.title = label
                elif not self.page.headings:
                    fail(where, "the page must start with its # title")
                self.page.headings.append((level, ident, markup))
                out.append(("heading", f'<h{level} id="{attribute(ident)}">{markup}<a class="anchor" href="#{attribute(ident)}" aria-label="Link to this section">#</a></h{level}>'))
                at += 1
                continue
            if text.startswith("#"):
                fail(where, "a heading needs a space after the #s (write \\# for a literal #)")

            if RULE.match(text):
                out.append(("rule", "<hr>"))
                at += 1
                continue

            if text.startswith(">"):
                quoted = []
                while at < count and lines[at][1].startswith(">"):
                    inner = lines[at][1][1:]
                    quoted.append((lines[at][0], inner[1:] if inner.startswith(" ") else inner))
                    at += 1
                if at < count and lines[at][1].strip() and not self.starts_block(lines[at][1].strip()):
                    fail(self.where(lines[at][0]), "this line follows a quote without a blank line: start it with > to keep it in the quote, "
                                                   "or leave a blank line to end the quote")
                out.append(("quote", "<blockquote>\n" + self.join(self.blocks(quoted)) + "\n</blockquote>"))
                continue

            if re.match(r"\[[^\]]+\]:\s", text):
                fail(where, "reference-style links are not supported: write [text](destination)")
            if re.match(r"</?[A-Za-z!]", text) and not AUTOLINK.match(text):
                fail(where, "raw HTML is not supported")

            if "|" in text and at + 1 < count and TABLE_RULE.match(lines[at + 1][1]) and "-" in lines[at + 1][1]:
                at = self.table(lines, at, out)
                continue

            if ITEM.match(text):
                at = self.list(lines, at, out)
                continue

            paragraph = [text.strip()]
            at += 1
            while at < count and lines[at][1].strip():
                following = lines[at][1].strip()
                here = self.where(lines[at][0])
                if re.match(r"^(=+|-+)$", following):
                    fail(here, "an underlined (setext) heading or a rule right after text: use # headings, and leave a blank line before ---")
                if TABLE_RULE.match(following) and "|" in following:
                    fail(here, "leave a blank line before a table")
                if self.starts_block(following):
                    if lines[at][1].startswith(" "):
                        fail(here, "this indented line looks like the start of a block: leave a blank line before it")
                    break
                paragraph.append(following)
                at += 1
            for line_number, raw in lines[at - len(paragraph):at - 1]:
                if raw.endswith("  "):
                    fail(self.where(line_number), "trailing spaces as a line break: end the line with \\ instead")
            markup = self.inline("\n".join(paragraph), where)
            # A picture on its own gets a box that scrolls sideways on a narrow screen.
            figure = ' class="figure"' if re.fullmatch(r"<img [^>]*>", markup) else ""
            out.append(("paragraph", f"<p{figure}>{markup}</p>"))
        return [(kind, markup, gap) for (kind, markup), gap in zip(out, gaps)]

    def join(self, blocks):
        return "\n".join(block[1] for block in blocks)

    def cells(self, text, where):
        text = text.strip()
        if text.startswith("|"):
            text = text[1:]
        if text.endswith("|") and not text.endswith("\\|"):
            text = text[:-1]
        cells = []
        current = []
        at = 0
        while at < len(text):
            if text[at] == "\\" and at + 1 < len(text) and text[at + 1] == "|":
                current.append("|")
                at += 2
            elif text[at] == "`":
                span = code_span(text, at)
                if span is None:
                    fail(where, "a code span is opened with ` but never closed")
                if "|" in text[at:span[2]].replace("\\|", ""):
                    fail(where, "a | inside a code span in a table: write \\|")
                current.append(text[at:span[2]].replace("\\|", "|"))
                at = span[2]
            elif text[at] == "|":
                cells.append("".join(current).strip())
                current = []
                at += 1
            else:
                current.append(text[at])
                at += 1
        cells.append("".join(current).strip())
        return cells

    def table(self, lines, at, out):
        where = self.where(lines[at][0])
        head = self.cells(lines[at][1], where)
        rule = self.cells(lines[at + 1][1], where)
        if len(head) != len(rule):
            fail(where, "the table's header and the line under it have different numbers of columns")
        classes = []
        for cell in rule:
            left, right = cell.startswith(":"), cell.endswith(":")
            classes.append(' class="center"' if left and right else ' class="right"' if right else "")
        rows = []
        at += 2
        while at < len(lines) and lines[at][1].strip():
            here = self.where(lines[at][0])
            if "|" not in lines[at][1]:
                fail(here, "leave a blank line after a table")
            row = self.cells(lines[at][1], here)
            if len(row) != len(head):
                fail(here, f"this table row has {len(row)} cells, the header has {len(head)}")
            rows.append("<tr>" + "".join(f"<td{classes[i]}>{self.inline(cell, here)}</td>" for i, cell in enumerate(row)) + "</tr>")
            at += 1
        header = "<tr>" + "".join(f"<th{classes[i]}>{self.inline(cell, where)}</th>" for i, cell in enumerate(head)) + "</tr>"
        out.append(("table", '<div class="table"><table>\n<thead>' + header + "</thead>\n<tbody>\n" + "\n".join(rows) + "\n</tbody>\n</table></div>"))
        return at

    def list(self, lines, at, out):
        first = ITEM.match(lines[at][1])
        ordered = first.group(1)[0].isdigit()
        kind = first.group(1)[-1] if ordered else first.group(1)
        same = lambda match: bool(match) and (match.group(1)[-1] == kind if ordered else match.group(1) == kind) and match.group(1)[0].isdigit() == ordered
        items = []
        loose = False
        count = len(lines)
        while at < count and same(ITEM.match(lines[at][1])):
            match = ITEM.match(lines[at][1])
            if len(match.group(2)) > 4:
                fail(self.where(lines[at][0]), "too many spaces after the list marker")
            offset = len(match.group(1)) + len(match.group(2))
            content = [(lines[at][0], match.group(3))]
            at += 1
            ended = False
            while at < count and not ended:
                number, text = lines[at]
                if not text.strip():
                    after = at
                    while after < count and not lines[after][1].strip():
                        after += 1
                    if after < count and indent_of(lines[after][1]) >= offset:
                        content.extend((lines[i][0], "") for i in range(at, after))
                        at = after
                    else:
                        # Blank lines and then a sibling item make the list loose. Before
                        # anything else they end the list and are left for the caller,
                        # which needs to see them to tell whether its own list is loose.
                        if after < count and same(ITEM.match(lines[after][1])):
                            loose = True
                            at = after
                        ended = True
                elif indent_of(text) >= offset:
                    content.append((number, text[offset:]))
                    at += 1
                elif same(ITEM.match(text)) or self.starts_block(text) or ITEM.match(text):
                    ended = True
                else:
                    fail(self.where(number), f"this line continues a list item but is not indented under it ({offset} spaces), "
                                             "or a blank line is missing after the list")
            items.append(self.blocks(content))
        # Also loose: an item whose own blocks are separated by a blank line.
        loose = loose or any(gap for blocks in items for _, _, gap in blocks)
        rendered = []
        for blocks in items:
            if not loose and blocks and blocks[0][0] == "paragraph" and blocks[0][1].startswith("<p>"):
                blocks = [("text", blocks[0][1][3:-4], False)] + blocks[1:]
            rendered.append("<li>" + self.join(blocks) + "</li>")
        start = int(first.group(1)[:-1]) if ordered else 1
        tag = "ol" if ordered else "ul"
        out.append(("list", f"<{tag}" + (f' start="{start}"' if start != 1 else "") + ">\n" + "\n".join(rendered) + f"\n</{tag}>"))
        return at

    def render(self, text):
        lines = [(number, line.rstrip("\r\n")) for number, line in enumerate(text.split("\n"), 1)]
        blocks = self.blocks(lines, top=True)
        if not self.page.title:
            fail(self.page.source, "the page has no # title")
        return self.join(blocks)


TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="{style}">
</head>
<body>
<a class="skip" href="#-text">Skip to the text</a>
<header class="top">
<a class="site" href="{front}" title="Back to the games">{site}</a>
<a class="here" href="{home}">Documentation</a>
</header>
<div class="layout">
<nav class="pages" aria-label="Documentation pages">
<ul>
{nav}
</ul>
</nav>
<main id="-text">
{body}
<nav class="around" aria-label="Previous and next page">
{around}
</nav>
<footer>
<p><a href="{front}">Back to the games</a></p>
</footer>
</main>
</div>
</body>
</html>
"""


def page_html(page, order):
    nav = []
    for other in order:
        current = other is page
        label = "Overview" if other.source == HOME else escape(other.title)
        entry = f'<a href="{attribute(page.href(other.folder, folder=True))}"' + (' aria-current="page"' if current else "") + f">{label}</a>"
        sections = [(ident, markup) for level, ident, markup in other.headings if level == 2] if current else []
        if sections:
            entry += '\n<ul class="sections">\n' + "\n".join(
                f'<li><a href="#{attribute(ident)}">{re.sub(r"</?a[^>]*>", "", markup)}</a></li>' for ident, markup in sections) + "\n</ul>"
        nav.append(f"<li>{entry}</li>")
    index = order.index(page)
    around = []
    if index > 0:
        previous = order[index - 1]
        around.append(f'<a class="previous" href="{attribute(page.href(previous.folder, folder=True))}"><small>Previous</small>{escape("Overview" if index == 1 else previous.title)}</a>')
    if index + 1 < len(order):
        following = order[index + 1]
        around.append(f'<a class="next" href="{attribute(page.href(following.folder, folder=True))}"><small>Next</small>{escape(following.title)}</a>')
    is_home = page.source == HOME
    return TEMPLATE.format(
        title=escape(f"{SITE_NAME} documentation" if is_home else f"{page.title} · {SITE_NAME} documentation"),
        style=attribute(page.href("docs/docs.css")),
        front=attribute(page.href(".", folder=True)),
        home=attribute(page.href("docs", folder=True)),
        site=escape(SITE_NAME),
        nav="\n".join(nav),
        body=page.body,
        around="\n".join(around),
    )


def build(root, dist):
    """Render the documentation of the checkout at `root` into <dist>/docs.
    Returns the number of pages."""
    docs = os.path.join(root, *PUBLIC.split("/"))
    if not os.path.isfile(os.path.join(root, *HOME.split("/"))):
        fail(HOME, "missing: it is the overview page of the documentation")
    tracked = repository_files(root)
    sources = [HOME] + sorted(PUBLIC + "/" + name for name in os.listdir(docs) if name.endswith(".md") and PUBLIC + "/" + name != HOME)
    pages = {source: Page(source) for source in sources}

    assets = set()
    for folder, dirs, names in os.walk(docs):
        dirs.sort()
        for name in sorted(names):
            path = os.path.relpath(os.path.join(folder, name), root).replace(os.sep, "/")
            if not name.endswith(".md"):
                assets.add(path)
            elif path not in pages:
                fail(path, f"pages live directly in {PUBLIC}/: a Markdown file in a subfolder would not be published")
    for page in pages.values():
        clash = [asset for asset in assets if site_path(asset) == page.folder or site_path(asset).startswith(page.folder + "/")]
        if clash and page.source != HOME:
            fail(page.source, f"its address is taken by {clash[0]}")
    if PUBLIC + "/index.html" in assets:
        fail(PUBLIC + "/index.html", f"the overview is rendered to this address from {HOME}")
    if PUBLIC + "/docs.css" not in assets:
        fail(PUBLIC + "/docs.css", "missing: the pages' style sheet")

    for page in pages.values():
        with open(os.path.join(root, page.source), encoding="utf-8") as fh:
            text = fh.read()
        page.body = Renderer(page, pages, root, tracked).render(text)

    for page in pages.values():
        for where, target, fragment in page.links:
            if fragment not in {ident for _, ident, _ in target.headings}:
                fail(where, f'there is no heading with the anchor "#{fragment}" in {target.source}')

    # The overview is the table of contents: the pages follow in the order it names them.
    home = pages[HOME]
    order = [home]
    for match in re.finditer(r'href="([^"#]+/)(?:#[^"]*)?"', home.body):
        for page in pages.values():
            if page not in order and home.href(page.folder, folder=True) == match.group(1):
                order.append(page)
    missing = [page.source for page in pages.values() if page not in order]
    if missing:
        fail(HOME, "does not link to " + ", ".join(missing) + ": every page must be reachable from the overview")

    out = os.path.join(dist, "docs")
    if os.path.exists(out):
        shutil.rmtree(out)
    for page in order:
        target = os.path.join(dist, *page.folder.split("/"), "index.html")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(page_html(page, order))
    for asset in sorted(assets):
        target = os.path.join(dist, *site_path(asset).split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(root, *asset.split("/")), target)
    return len(order)


# --- self-test -----------------------------------------------------------------

def self_test():
    import tempfile

    def site(files, git=False):
        """Build a throwaway checkout from {path: text}; returns (page markup by address, error)."""
        with tempfile.TemporaryDirectory() as folder:
            root = os.path.join(folder, "repo")
            for path, text in {PUBLIC + "/docs.css": "", **files}.items():
                target = os.path.join(root, path)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "w", encoding="utf-8") as fh:
                    fh.write(text)
            if git:
                subprocess.run(["git", "init", "-q", root], check=True, capture_output=True)
            dist = os.path.join(folder, "dist")
            try:
                build(root, dist)
            except DocsError as error:
                return {}, str(error)
            result = {}
            for base, _, names in os.walk(dist):
                for name in names:
                    with open(os.path.join(base, name), encoding="utf-8") as fh:
                        result[os.path.relpath(os.path.join(base, name), dist).replace(os.sep, "/")] = fh.read()
            return result, None

    failures = []

    def renders(name, markdown, *expected):
        pages, error = site({HOME: "# T\n\n" + markdown})
        text = pages.get("docs/index.html", "")
        for piece in expected:
            if error or piece not in text:
                failures.append(f"{name}: expected {piece!r}, got {error or text[text.find('<main'):text.find('<nav class=' + chr(34) + 'around')]!r}")

    def refuses(name, markdown, reason, extra=None):
        _, error = site({HOME: "# T\n\n" + markdown, **(extra or {})})
        if not error or reason not in error:
            failures.append(f"{name}: expected a failure mentioning {reason!r}, got {error!r}")

    renders("paragraph", "one\ntwo & 3 < 4 > 2", "<p>one\ntwo &amp; 3 &lt; 4 &gt; 2</p>")
    renders("inline", "a `x < *y*` **b _c_** *d* e_f_g 2 * 3 \\*h\\*", "<code>x &lt; *y*</code>", "<strong>b <em>c</em></strong>", "<em>d</em>", "e_f_g 2 * 3 *h*")
    renders("code span padding", "`` a`b ``", "<code>a`b</code>")
    renders("heading", "## Status levels: `ingame` & co\n\n[go](#status-levels-ingame-co)", '<h2 id="status-levels-ingame-co">', 'href="#status-levels-ingame-co"')
    renders("fence", "```sh\na < b\n\n  **c**\n```", '<pre><code class="language-sh">a &lt; b\n\n  **c**\n</code></pre>')
    renders("tight list", "- a\n- b\n  c\n  - d\n- e", "<ul>\n<li>a</li>\n<li>b\nc\n<ul>\n<li>d</li>\n</ul></li>\n<li>e</li>\n</ul>")
    renders("loose list", "1. a\n\n   ```\n   x\n\n   y\n   ```\n2. b\n\nafter", "<ol>\n<li><p>a</p>\n<pre><code>x\n\ny\n</code></pre></li>\n<li><p>b</p></li>\n</ol>\n<p>after</p>")
    renders("list start", "3. a\n4. b", '<ol start="3">')
    renders("list after text", "text\n- a", "<p>text</p>\n<ul>")
    renders("table", "| A | B |\n|---|--:|\n| `a\\|b` | [x](https://e.org/a_b) |", "<th>A</th>", '<th class="right">B</th>', "<td><code>a|b</code></td>", '<td class="right"><a href="https://e.org/a_b">x</a></td>')
    renders("quote", "> a\n> - b", "<blockquote>\n<p>a</p>\n<ul>\n<li>b</li>\n</ul>\n</blockquote>")
    renders("autolink", "<https://e.org/?a=1&b=2>", '<a href="https://e.org/?a=1&amp;b=2">https://e.org/?a=1&amp;b=2</a>')
    renders("rule and break", "a\\\nb\n\n---", "a<br>\nb", "<hr>")
    renders("literal brackets", "build.py [--out DIR] a < b", "build.py [--out DIR] a &lt; b")

    refuses("html", "<div>x</div>", "raw HTML")
    refuses("inline html", "a <b>x</b>", "raw HTML")
    refuses("entity", "a &nbsp; b", "entities")
    refuses("reference link", "[a][b]\n\n[b]: https://e.org", "reference-style")
    refuses("setext", "Title\n=====", "setext")
    refuses("indented code", "a\n\n    code", "indentation")
    refuses("open fence", "```\ncode", "never closed")
    refuses("open code span", "a `b", "never closed")
    refuses("open emphasis", "a *b", "never closed")
    refuses("stray star", "a* b", "never opened")
    refuses("table shape", "| A | B |\n|---|---|\n| a |", "cells")
    refuses("lazy list line", "- a\nb", "not indented")
    refuses("tab", "-\ta", "tab")
    refuses("deep heading", "##### a", "deeper")
    refuses("second title", "# again", "one # title")
    refuses("duplicate anchor", "## A b\n\n## a-b", "share the anchor")
    refuses("bare url", "see https://e.org", "bare URL")
    refuses("hard break", "a  \nb", "trailing spaces")
    refuses("footnote", "a[^1]", "footnotes")
    refuses("dead anchor", "[x](#nowhere)", "no heading")
    refuses("dead file", "[x](../../tools/nothing.py)", "there is no tools/nothing.py")
    refuses("dead page", "[x](nothing.md)", "there is no page")
    refuses("site path", "[x](/play/)", "site root")
    refuses("outside", "[x](../../../other/file)", "outside the repository")
    refuses("submodule", "[x](../../eka2l1/README.md)", "submodule")
    refuses("remote image", "![x](https://e.org/x.png)", "only files in docs/public/")
    refuses("unpublished image", "![x](../overview.svg)", "are published", {"docs/overview.svg": "<svg/>"})
    refuses("unlinked page", "text", "does not link to docs/public/a.md", {"docs/public/a.md": "# A\n"})
    refuses("dead cross anchor", "[a](a.md#nope)", "no heading", {"docs/public/a.md": "# A\n"})
    refuses("page in a subfolder", "text", "pages live directly in docs/public/", {"docs/public/sub/a.md": "# A\n"})
    refuses("lazy quote line", "> a\nb", "follows a quote")
    refuses("spaced rule", "* * *", "rule written with spaces")
    refuses("link in a heading", "## See [x](https://e.org)", "link in a heading")

    renders("rule after text", "a\n***", "<p>a</p>\n<hr>")
    renders("url as link text", "[https://e.org](https://e.org)", '<a href="https://e.org">https://e.org</a>')
    renders("content heading", "## Content\n\n[x](#content)", '<h2 id="content">', '<main id="-text">')
    renders("nested loose list", "- a\n  - b\n\n  - c\n- d", "<ul>\n<li>a\n<ul>\n<li><p>b</p></li>\n<li><p>c</p></li>\n</ul></li>\n<li>d</li>\n</ul>")
    renders("blank after nested list", "- a\n  - b\n\n  c\n- d", "<ul>\n<li><p>a</p>\n<ul>\n<li>b</li>\n</ul>\n<p>c</p></li>\n<li><p>d</p></li>\n</ul>")
    renders("blank inside code in a tight list", "- a\n  ```\n  x\n\n  y\n  ```\n- b", "<li>a\n<pre><code>x\n\ny\n</code></pre></li>\n<li>b</li>")
    renders("list then text", "- a\n\ntext", "<ul>\n<li>a</li>\n</ul>\n<p>text</p>")

    pages, error = site({
        HOME: "# T\n\n[b](b.md), [a](a.md#part-two), [tool](../../tools/x.py), [dev](../building.md), ![d](d.svg)\n",
        "docs/public/a.md": "# A page\n\n## Part two\n\n[home](index.md#t), [b](b.md), [tool](../../tools/x.py#L3), ![d](d.svg)\n",
        "docs/public/b.md": "# B page\n",
        "docs/public/d.svg": "<svg/>",
        "docs/building.md": "# Not published\n",
        "tools/x.py": "",
    })
    home = pages.get("docs/index.html", "")
    a = pages.get("docs/a/index.html", "")
    checks = [
        (error is None, f"site: {error}"),
        ('href="b/"' in home and 'href="a/#part-two"' in home and 'src="d.svg"' in home, "site: links from the overview"),
        (f'href="{FORGE}tools/x.py"' in home, "site: link to a repository file"),
        ('href="../#t"' in a and 'href="../b/"' in a and 'src="../d.svg"' in a and f'href="{FORGE}tools/x.py#L3"' in a, "site: links from a page"),
        ('href="../../"' in a and 'href="../docs.css"' in a and 'href="../"' in home, "site: front page and style sheet"),
        (home.find('href="b/"', home.find('class="pages"')) < home.find('href="a/"', home.find('class="pages"')), "site: pages follow the overview's order"),
        ('<a href="#part-two">Part two</a>' in a and 'aria-current="page">A page' in a, "site: sections of the current page"),
        ("docs/d.svg" in pages and "docs/docs.css" in pages, "site: other files are copied"),
        (f'href="{FORGE}docs/building.md"' in home and "docs/building/index.html" not in pages, "site: pages outside docs/public/ are not published"),
        ("in the repository" not in a, "site: no link to the page's source"),
        ('class="previous" href="../b/"' in a and 'class="next" href="b/"' in home, "site: previous and next"),
    ]
    failures += [message for ok, message in checks if not ok]

    # A file git ignores exists here but not on the forge. Needs git, as the check itself does.
    if shutil.which("git"):
        ignored = {HOME: "# T\n\n[x](../../testdata/x.bin) [y](../../tools/y.py)\n", ".gitignore": "/testdata/\n", "testdata/x.bin": "", "tools/y.py": ""}
        _, error = site(ignored, git=True)
        if not error or "ignored by git" not in error or "testdata/x.bin" not in error:
            failures.append(f"ignored file: expected a failure for testdata/x.bin, got {error!r}")
        _, error = site({**ignored, HOME: "# T\n\n[y](../../tools/y.py) [dir](../../tools/)\n"}, git=True)
        if error:
            failures.append(f"untracked file and folder: {error}")

    for failure in failures:
        print("FAIL", failure, file=sys.stderr)
    print(f"docs renderer self-test: {len(failures)} failures")
    return 1 if failures else 0


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.split("\n\n")[1])
    if sys.argv[1] == "--self-test":
        return self_test()
    try:
        count = build(ROOT, os.path.abspath(sys.argv[1]))
    except DocsError as error:
        sys.exit(f"docs: {error}")
    print(f"docs: {count} pages in {os.path.join(os.path.abspath(sys.argv[1]), 'docs')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
