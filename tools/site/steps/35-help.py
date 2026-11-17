#!/usr/bin/env python3
"""Site build step: every finding of the player's diagnostics has its help.

  python3 -I 35-help.py <output folder>      (run by tools/site/build.py)
  python3 -I 35-help.py --self-test          checks this check

The player's Diagnostics dialog links each finding to its section of the help
page, /docs/troubleshooting/ (docs/public/troubleshooting.md). Three lists
must agree for that link to lead somewhere, and this step stops the build
when they do not:

  the findings      the table under "Findings" in docs/diagnostics.md. The
                    codes are fixed in the emulator fork (shell/diag/codes.js),
                    but the site is also built where the fork is not checked
                    out, so the table stands in for it here.
  the help page     as the docs step (30) published it. A section belongs to
                    a finding when it holds the line
                        *In a report: `the-code`*
                    and its address is the id of the heading above that line.
  the player        the player's files in the output folder: diag/codes.js,
                    the findings as the player itself has them (CODES), and
                    diag/help.js, the address of each finding's section
                    (HELP_PAGE and the HELP_ANCHORS table).

It fails when a finding has no section, when a section names a code that is no
finding, when two sections name the same code or one names two, when the
player's findings are not those of the table, and when the player would link
a finding anywhere but to its section.

It does not fail on a player that has no table of addresses, which is a build
of the emulator from before the help page: such a player shows its findings
without a link, so nothing leads nowhere. That is printed as a warning, and
so is an output folder without a player.

Nothing is added to the output folder.
"""
import html
import os
import re
import sys

# The checkout this script belongs to, not an inherited ARCADE_ROOT, like the
# docs step whose page is checked here: both must read the same checkout.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
TABLE = "docs/diagnostics.md"                 # the reference page with the table of findings
TABLE_HEADING = "Findings"
SOURCE = "docs/public/troubleshooting.md"     # the help page
PAGE = "troubleshooting/"                     # its address under /docs/ (the docs step: <name>.md -> <name>/)
LEAD = "In a report:"                         # what the line that names a section's code starts with

CODE = r"[a-z0-9]+(?:-[a-z0-9]+)*"
HEADING = re.compile(r'<h([1-4]) id="([^"]*)">')
MARK = re.compile(r"<p><em>" + re.escape(LEAD) + r" <code>([^<]*)</code></em></p>")
TABLE_HEAD = "Code"                           # first cell of the header of the table of findings
TABLE_ROW = re.compile(r"^\|\s*`(" + CODE + r")`\s*\|")
HELP_PAGE = re.compile(r"""^export const HELP_PAGE = (['"])([^'"]*)\1;""", re.M)
JS_TABLE = r"^export const %s = \{\n(.*?)^\};"
JS_ENTRY = re.compile(r"""^\s*(['"])(?P<key>[^'"]+)\1:\s*(['"])(?P<value>[^'"]+)\3,?\s*(?://.*)?$""")


class HelpError(Exception):
    pass


def finding_codes(markdown):
    """The codes in the first column of the table under "## Findings" whose
    header starts with "Code". Other tables of that section are not read."""
    codes = []
    inside = False     # under the heading
    table = None       # in a table: whether it is the one of the codes
    for line in markdown.split("\n"):
        if line.startswith("## "):
            inside = line[3:].strip() == TABLE_HEADING
            table = None
        elif not inside:
            continue
        elif not line.lstrip().startswith("|"):
            table = None
        elif table is None:
            table = line.strip().strip("|").split("|")[0].strip() == TABLE_HEAD
        elif table:
            row = TABLE_ROW.match(line)
            if row:
                if row.group(1) in codes:
                    raise HelpError(f'{TABLE}: the table under "{TABLE_HEADING}" lists `{row.group(1)}` twice')
                codes.append(row.group(1))
    if not codes:
        raise HelpError(f'{TABLE}: no table of finding codes under "## {TABLE_HEADING}" (its header starts with | {TABLE_HEAD} |, a row with | `code` |)')
    return codes


def page_sections(page):
    """{code: anchor} of the published help page: for every section that
    names a code, the id of its heading."""
    start = page.find("<main")
    end = page.find("</main>")
    if start < 0 or end < 0:
        raise HelpError(f"/docs/{PAGE}: not a page of the docs step (no <main>)")
    body = page[start:end]
    headings = list(HEADING.finditer(body))
    if not headings:
        raise HelpError(f"/docs/{PAGE}: no headings found: has the docs step changed what it writes?")
    sections = {}
    marked = 0
    for index, heading in enumerate(headings):
        chunk = body[heading.end():headings[index + 1].start() if index + 1 < len(headings) else len(body)]
        anchor = html.unescape(heading.group(2))
        codes = [html.unescape(code) for code in MARK.findall(chunk)]
        marked += len(codes)
        if len(codes) > 1:
            raise HelpError(f'{SOURCE}: the section "#{anchor}" names {len(codes)} codes ({", ".join(codes)}): a section explains one finding')
        for code in codes:
            if not re.fullmatch(CODE, code):
                raise HelpError(f'{SOURCE}: the section "#{anchor}" names "{code}", which is not written like a finding code')
            if code in sections:
                raise HelpError(f'{SOURCE}: `{code}` is named by two sections, "#{sections[code]}" and "#{anchor}"')
            sections[code] = anchor
    # A line that starts like the one that names a code but is written another
    # way would leave its section without a code, silently.
    stray = len(re.findall(re.escape(LEAD), re.sub(r"<[^>]+>", "", body))) - marked
    if stray:
        raise HelpError(f'{SOURCE}: {stray} line(s) with "{LEAD}" are not written as a paragraph of their own of the form *{LEAD} `code`*')
    return sections


def js_table(script, name):
    """{key: value} of `export const <name> = { 'key': 'value', ... };` in a
    script of the player, read as text: one entry per line, comments allowed.
    None when the script does not have it written that way."""
    table = re.search(JS_TABLE % re.escape(name), script, re.M | re.S)
    if not table:
        return None
    entries = {}
    for line in table.group(1).split("\n"):
        if not line.strip() or line.strip().startswith("//"):
            continue
        entry = JS_ENTRY.match(line)
        if not entry:
            raise HelpError(f"cannot read this line of the {name} table: {line.strip()}")
        if entry.group("key") in entries:
            raise HelpError(f"the {name} table has `{entry.group('key')}` twice")
        entries[entry.group("key")] = entry.group("value")
    if not entries:
        raise HelpError(f"the {name} table is empty")
    return entries


def player_table(script):
    """(page, {code: anchor}) as diag/help.js of the player has them, or None
    when that file has no table (a player from before the help page)."""
    if "HELP_ANCHORS" not in script:
        return None
    page = HELP_PAGE.search(script)
    anchors = js_table(script, "HELP_ANCHORS")
    if not page or anchors is None:
        raise HelpError("cannot read HELP_PAGE and the HELP_ANCHORS table: they are read as text here, "
                        "written as `export const HELP_PAGE = '...';` and `export const HELP_ANCHORS = {` with one `'code': 'anchor',` per line")
    return page.group(2), anchors


def player_codes(script):
    """The finding codes as diag/codes.js of the player has them."""
    codes = js_table(script, "CODES")
    if codes is None:
        raise HelpError("cannot read the CODES table: it is read as text here, written as `export const CODES = {` with one `'code': 'section',` per line")
    return list(codes)


def listed(codes):
    return ", ".join(f"`{code}`" for code in codes)


def check(table_markdown, page, players):
    """Raises HelpError on the first disagreement. `players` maps each diag/
    folder of a player in the output folder to {file name: text} for its
    codes.js and help.js, whichever it has. Returns the warnings."""
    codes = finding_codes(table_markdown)
    sections = page_sections(page)
    missing = [code for code in codes if code not in sections]
    if missing:
        raise HelpError(f'{SOURCE}: no section for {listed(missing)}. Every finding in the table of {TABLE} ("{TABLE_HEADING}") '
                        f"needs a section there that holds the line *{LEAD} `code`*")
    unknown = [code for code in sections if code not in codes]
    if unknown:
        raise HelpError(f'{SOURCE}: {listed(unknown)} has a section but is not a finding: the table of {TABLE} ("{TABLE_HEADING}") does not list it')

    notes = []
    for folder, files in sorted(players.items()):
        advice = (f"The emulator fork's shell/diag/codes.js and shell/diag/help.js, the table of {TABLE} and the headings of {SOURCE} must change together; "
                  "build the site with a player that matches (--bin, or --shell with the fork's page sources)")
        if "codes.js" in files:
            path = f"{folder}/codes.js"
            try:
                own = player_codes(files["codes.js"])
            except HelpError as error:
                raise HelpError(f"{path}: {error}") from None
            only_player = [code for code in own if code not in codes]
            only_table = [code for code in codes if code not in own]
            if only_player or only_table:
                raise HelpError(f'{path}: the player\'s findings are not those of the table of {TABLE} ("{TABLE_HEADING}"): '
                                + "; ".join(part for part in (only_player and f"only the player has {listed(only_player)}",
                                                              only_table and f"only the table has {listed(only_table)}") if part)
                                + f". {advice}")
        path = f"{folder}/help.js"
        try:
            table = player_table(files["help.js"]) if "help.js" in files else None
        except HelpError as error:
            raise HelpError(f"{path}: {error}") from None
        if table is None:
            notes.append(f"the player in {folder} has no table of help addresses (an emulator build from before the help page): "
                         "its findings are shown without a link to the help page")
            continue
        where, anchors = table
        if where != PAGE:
            raise HelpError(f'{path}: the player looks for the help page at "{where}" under the documentation, and it is published at "{PAGE}". {advice}')
        without = [code for code in codes if code not in anchors]
        if without:
            raise HelpError(f"{path}: the player has no help address for {listed(without)}. {advice}")
        extra = [code for code in anchors if code not in codes]
        if extra:
            raise HelpError(f'{path}: the player has a help address for {listed(extra)}, which is no finding in the table of {TABLE} ("{TABLE_HEADING}"). {advice}')
        wrong = [f'`{code}` to "#{anchors[code]}" where its section is "#{sections[code]}"' for code in codes if anchors[code] != sections[code]]
        if wrong:
            raise HelpError(f"{path}: the player would link {'; '.join(wrong)}. {advice}")
    if not players:
        notes.append("the output folder has no player with diagnostics: only the help page was checked against the findings")
    return notes


def player_files(out):
    """The diagnostics of every player under <out>/play, as
    {its diag/ folder relative to out: {"codes.js" | "help.js": text}}."""
    found = {}
    for folder, dirs, names in os.walk(os.path.join(out, "play")):
        dirs.sort()
        if os.path.basename(folder) != "diag":
            continue
        files = {}
        for name in ("codes.js", "help.js"):
            if name in names:
                with open(os.path.join(folder, name), encoding="utf-8") as fh:
                    files[name] = fh.read()
        if files:
            found[os.path.relpath(folder, out).replace(os.sep, "/")] = files
    return found


def run(out):
    try:
        with open(os.path.join(ROOT, *TABLE.split("/")), encoding="utf-8") as fh:
            table = fh.read()
    except OSError as error:
        raise HelpError(f"{TABLE}: {error}") from None
    published = os.path.join(out, "docs", *PAGE.strip("/").split("/"), "index.html")
    try:
        with open(published, encoding="utf-8") as fh:
            page = fh.read()
    except OSError:
        raise HelpError(f"there is no /docs/{PAGE} in {out}: {SOURCE} is missing, or the docs step (30) has not run") from None
    return len(finding_codes(table)), check(table, page, player_files(out))


# --- self-test -----------------------------------------------------------------

def self_test():
    table = ("# D\n\n## Other\n\n| Code | x |\n|---|---|\n| `not-this` | x |\n\n## Findings\n\nLevels:\n\n| Level | Meaning |\n|---|---|\n| `bad` | x |\n\n"
             "| Code | Section | Meaning |\n|---|---|---|\n| `one-thing` | a | b |\n| `other` | a | b |\n\n## Next\n\n| Code | x |\n|---|---|\n| `nor-this` | x |\n")

    def page(*sections, tail=""):
        body = '<h1 id="t">T<a class="anchor" href="#t">#</a></h1>\n<p>In short.</p>\n'
        for anchor, codes in sections:
            body += f'<h3 id="{anchor}">Heading<a class="anchor" href="#{anchor}">#</a></h3>\n<p>Text.</p>\n'
            body += "".join(f"<p><em>In a report: <code>{code}</code></em></p>\n" for code in codes)
        return f'<body><h2 id="outside">not the text</h2><main id="-text">\n{body}{tail}</main></body>'

    def help_js(anchors, where="troubleshooting/"):
        lines = "".join(f"  '{code}': '{anchor}',\n" for code, anchor in anchors.items())
        return f"// HELP_ANCHORS below\nexport const HELP_PAGE = '{where}';\n\nexport const HELP_ANCHORS = {{\n{lines}}};\n\nexport function helpLink() {{}}\n"

    def codes_js(*codes):
        return "export const CODES = {\n  // a.js\n" + "".join(f"  '{code}': 'a',\n" for code in codes) + "};\n\nexport const LEVELS = ['bad'];\n"

    def player(help_script=None, codes_script=None, folder="play/b/x/diag"):
        files = {}
        if help_script is not None:
            files["help.js"] = help_script
        if codes_script is not None:
            files["codes.js"] = codes_script
        return {folder: files}

    good = page(("first-thing", ["one-thing"]), ("about", []), ("second", ["other"]))
    anchors = {"one-thing": "first-thing", "other": "second"}
    failures = []

    def passes(name, *arguments, note=None):
        try:
            notes = check(*arguments)
        except HelpError as error:
            failures.append(f"{name}: expected to pass, got {error}")
            return
        if (note is None and notes) or (note is not None and not any(note in text for text in notes)):
            failures.append(f"{name}: expected {'no warning' if note is None else 'a warning with ' + repr(note)}, got {notes!r}")

    def refuses(name, reason, *arguments):
        try:
            check(*arguments)
        except HelpError as error:
            if reason not in str(error):
                failures.append(f"{name}: expected a failure mentioning {reason!r}, got {str(error)!r}")
            return
        failures.append(f"{name}: expected a failure mentioning {reason!r}, and it passed")

    passes("all agree", table, good, player(help_js(anchors), codes_js("one-thing", "other")))
    passes("a player without its list of codes", table, good, player(help_js(anchors)))
    passes("no player", table, good, {}, note="no player")
    passes("a player from before the help page", table, good, player("export function helpLink() { return null; }\n", codes_js("one-thing", "other")), note="without a link")
    passes("a player from before the diagnostics' help file", table, good, player(None, codes_js("one-thing", "other")), note="without a link")
    passes("a table with comments and double quotes", table, good,
           player('export const HELP_PAGE = "troubleshooting/";\nexport const HELP_ANCHORS = {\n  // first\n  "one-thing": "first-thing", // why\n\n  \'other\': \'second\'\n};\n'))

    refuses("a finding without a section", "no section for `other`", table, page(("first-thing", ["one-thing"])), {})
    refuses("a section for no finding", "`gone` has a section but is not a finding", table, page(("first-thing", ["one-thing"]), ("second", ["other"]), ("third", ["gone"])), {})
    refuses("a code under another heading is no finding", "`not-this` has a section", table, page(("first-thing", ["one-thing"]), ("second", ["other"]), ("third", ["not-this"])), {})
    refuses("a code of another table under the heading is no finding", "`bad` has a section", table, page(("first-thing", ["one-thing"]), ("second", ["other"]), ("third", ["bad"])), {})
    refuses("two sections for one code", "named by two sections", table, page(("first-thing", ["one-thing"]), ("second", ["other"]), ("third", ["other"])), {})
    refuses("two codes in one section", "names 2 codes", table, page(("first-thing", ["one-thing", "other"])), {})
    refuses("a code line written another way", "are not written as", table, page(("first-thing", ["one-thing"]), ("second", ["other"]), tail="<p>In a report: <code>other</code></p>\n"), {})
    refuses("a code line inside a paragraph", "are not written as", table, page(("first-thing", ["one-thing"]), ("second", ["other"]), tail="<p>Text. <em>In a report: <code>other</code></em></p>\n"), {})
    refuses("not a code", "not written like a finding code", table, page(("first-thing", ["One thing"]), ("second", ["other"])), {})
    refuses("no table of findings", "no table of finding codes", "# D\n\n## Findings\n\nNone.\n", good, {})
    refuses("a table of something else", "no table of finding codes", "# D\n\n## Findings\n\n| Level | x |\n|---|---|\n| `bad` | x |\n", good, {})
    refuses("a code twice in the table", "twice", table.replace("`other`", "`one-thing`"), good, {})
    refuses("no page body", "no <main>", table, "<html></html>", {})
    refuses("headings outside the text do not count", "no headings found", table, '<h2 id="outside">x</h2><main></main>', {})

    refuses("the player links elsewhere", '`other` to "#old-name" where its section is "#second"', table, good, player(help_js({**anchors, "other": "old-name"})))
    refuses("the player lacks an address", "no help address for `other`", table, good, player(help_js({"one-thing": "first-thing"})))
    refuses("the player has an address too many", "help address for `gone`", table, good, player(help_js({**anchors, "gone": "second"})))
    refuses("the player looks at another page", 'at "help/"', table, good, player(help_js(anchors, where="help/")))
    refuses("a table that cannot be read", "cannot read HELP_PAGE", table, good, player("export const HELP_ANCHORS = new Map();\n"))
    refuses("a line that cannot be read", "cannot read this line", table, good, player(help_js(anchors).replace("'other': 'second',", "other: anchor('second'),")))
    refuses("an empty table", "is empty", table, good, player(help_js({})))
    refuses("one of two players is wrong", "play/old/diag/help.js", table, good,
            {**player(help_js(anchors)), **player(help_js({**anchors, "other": "old-name"}), folder="play/old/diag")})
    refuses("the player has a finding the table has not", "only the player has `new-one`", table, good, player(help_js(anchors), codes_js("one-thing", "other", "new-one")))
    refuses("the table has a finding the player has not", "only the table has `other`", table, good, player(help_js(anchors), codes_js("one-thing")))
    refuses("an old player with other findings", "play/b/x/diag/codes.js", table, good, player(None, codes_js("one-thing")))
    refuses("a list of codes that cannot be read", "cannot read the CODES table", table, good, player(help_js(anchors), "export const CODES = new Map();\n"))

    for failure in failures:
        print("FAIL", failure, file=sys.stderr)
    print(f"help check self-test: {len(failures)} failures")
    return 1 if failures else 0


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.split("\n\n")[1])
    if sys.argv[1] == "--self-test":
        return self_test()
    try:
        count, notes = run(os.path.abspath(sys.argv[1]))
    except HelpError as error:
        sys.exit(f"help: {error}")
    for note in notes:
        print(f"WARNING: help: {note}", file=sys.stderr)
    print(f"help: {count} findings, each with its section in /docs/{PAGE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
