#!/usr/bin/env python3
"""Give every page of the site the same icons and share tags.

  python3 -I tools/site/steps/70-head.py <dist>

The front page, the 404 page, the documentation and the player come from three
places (site/, tools/site/steps/30-docs.py, the fork's shell/index.html), so
what a browser tab, a home screen or a link preview shows of them is decided
here, once, for all of them. Each page keeps its own <title>, description and
theme colours; this step adds the rest before </head>:

  icons      /favicon.ico, /favicon.svg, /apple-touch-icon.png, /site.webmanifest
             (any icon link a page brought is replaced by these)
  canonical  https://n-ga.ge<address>, not on a page that asks not to be indexed
  share      Open Graph and the X card: the page's title and description, and
             /og.png (1200x630, drawn by tools/site/brand.mjs)

The player's page is the fork's, made for any host: here it gets the site's
title (the player puts the running game's name in front of it) and a
description. A link to one game, /play/?g=<slug>, has the same page for
every game, so its preview would be the player's; the share Worker
(cloudflare/share-worker/) puts the game's title, description and screenshot
into its share tags on the live site.

It also writes /robots.txt and /sitemap.xml (the front page, the documentation
and one player address per game).

The build stops when a page has no <title>, an indexed page has no
description, or a file named here is missing from the site.
"""
import html
import json
import os
import re
import sys

ORIGIN = "https://n-ga.ge"
SITE_NAME = "n-ga.ge"
IMAGE = {"path": "/og.png", "width": 1200, "height": 630,
         "alt": "The n-ga.ge wordmark beside a stack of N-Gage game cards: N-Gage games, playable in the browser."}
ICONS = ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/site.webmanifest",
         "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", IMAGE["path"]]
# Pages whose own head does not say what the site needs: the player's page is
# the fork's and names no site. "title" replaces the page's <title>.
OVERRIDES = {
    "play/index.html": {
        "title": SITE_NAME,
        "share_title": "Play an N-Gage game · n-ga.ge",
        "description": "The n-ga.ge player: the EKA2L1 emulator compiled to WebAssembly, running Nokia N-Gage games "
                       "in the browser with keyboard, gamepad and touch controls.",
    },
}
# Folders of the site that hold no pages of their own.
SKIP = ("play/b/", "s/")


def attr(text):
    return html.escape(text, quote=True)


def address(relative):
    """The page's address on the site, or None for the 404 page."""
    if relative == "404.html":
        return None
    if relative == "index.html":
        return "/"
    if relative.endswith("/index.html"):
        return "/" + relative[: -len("index.html")]
    return "/" + relative


def meta_content(head, key, value):
    for tag in re.findall(r"<meta\b[^>]*>", head, re.I):
        if re.search(rf'\b{key}="{re.escape(value)}"', tag, re.I):
            found = re.search(r'\bcontent="([^"]*)"', tag)
            return html.unescape(found.group(1)) if found else ""
    return None


def head_of(relative, page):
    start, end = page.find("<head>"), page.find("</head>")
    if start < 0 or end < start:
        sys.exit(f"70-head: {relative} has no <head>")
    return start + len("<head>"), end


def rewrite(relative, page):
    where = relative
    start, end = head_of(where, page)
    head = page[start:end]
    override = OVERRIDES.get(relative, {})

    if "title" in override:
        head, count = re.subn(r"<title>.*?</title>", f"<title>{html.escape(override['title'])}</title>", head, flags=re.S)
        if not count:
            sys.exit(f"70-head: {where} has no <title>")
    title = re.search(r"<title>(.*?)</title>", head, re.S)
    if not title or not title.group(1).strip():
        sys.exit(f"70-head: {where} has no <title>")
    title = html.unescape(title.group(1).strip())

    if "description" in override:
        head = re.sub(r'<meta name="description"[^>]*>\n?', "", head)
        head = head.replace("</title>", f'</title>\n<meta name="description" content="{attr(override["description"])}">', 1)
    description = meta_content(head, "name", "description")
    robots = meta_content(head, "name", "robots") or ""
    indexed = "noindex" not in robots and address(relative) is not None
    if indexed and not description:
        sys.exit(f"70-head: {where} has no <meta name=\"description\">: every page that search engines list needs one")

    # One set of icons for the whole site: drop whatever the page brought.
    head = re.sub(r'<link\b[^>]*\brel="(?:icon|shortcut icon|apple-touch-icon|manifest|canonical)"[^>]*>\n?', "", head)
    head = re.sub(r'<meta\b[^>]*\b(?:property="og:|name="twitter:|name="application-name"|name="apple-mobile-web-app-title")[^>]*>\n?', "", head)

    tags = [
        '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">',
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
        '<link rel="manifest" href="/site.webmanifest">',
        f'<meta name="application-name" content="{SITE_NAME}">',
        f'<meta name="apple-mobile-web-app-title" content="{SITE_NAME}">',
    ]
    url = ORIGIN + address(relative) if address(relative) else None
    if url and indexed:
        tags.append(f'<link rel="canonical" href="{attr(url)}">')
    share_title = override.get("share_title", title)
    tags += [
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{SITE_NAME}">',
        f'<meta property="og:title" content="{attr(share_title)}">',
    ]
    if description:
        tags.append(f'<meta property="og:description" content="{attr(description)}">')
    if url:
        tags.append(f'<meta property="og:url" content="{attr(url)}">')
    tags += [
        f'<meta property="og:image" content="{ORIGIN}{IMAGE["path"]}">',
        f'<meta property="og:image:width" content="{IMAGE["width"]}">',
        f'<meta property="og:image:height" content="{IMAGE["height"]}">',
        f'<meta property="og:image:alt" content="{attr(IMAGE["alt"])}">',
        '<meta name="twitter:card" content="summary_large_image">',
    ]
    head = head.rstrip("\n") + "\n<!-- icons and share tags: tools/site/steps/70-head.py -->\n" + "\n".join(tags) + "\n"
    return page[:start] + head + page[end:], (url if indexed else None)


def sitemap(dist, urls):
    games = []
    folder = os.path.join(dist, "catalog", "games")
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if name.endswith(".json"):
            with open(os.path.join(folder, name), encoding="utf-8") as fh:
                games.append(json.load(fh)["slug"])
    urls = sorted(set(urls) - {ORIGIN + "/play/"}, key=lambda url: (url != ORIGIN + "/", url))
    urls += [f"{ORIGIN}/play/?g={slug}" for slug in games]
    entries = "\n".join(f"  <url><loc>{html.escape(url)}</loc></url>" for url in urls)
    with open(os.path.join(dist, "sitemap.xml"), "w", encoding="utf-8") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + entries + "\n</urlset>\n")
    with open(os.path.join(dist, "robots.txt"), "w", encoding="utf-8") as fh:
        # The game files are behind the assets Worker and are no use to a crawler.
        fh.write(f"User-agent: *\nDisallow: /assets/\nDisallow: /net/\n\nSitemap: {ORIGIN}/sitemap.xml\n")
    return len(urls)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.split("\n\n")[1])
    dist = os.path.abspath(sys.argv[1])
    missing = [path for path in ICONS if not os.path.isfile(os.path.join(dist, path.lstrip("/")))]
    if missing:
        sys.exit(f"70-head: missing from the site: {', '.join(missing)} (site/; tools/site/brand.mjs draws the pictures)")
    pages, urls = 0, []
    for folder, dirs, names in os.walk(dist):
        dirs.sort()
        for name in sorted(names):
            relative = os.path.relpath(os.path.join(folder, name), dist).replace(os.sep, "/")
            if not name.endswith(".html") or relative.startswith(SKIP):
                continue
            with open(os.path.join(folder, name), encoding="utf-8") as fh:
                page = fh.read()
            page, url = rewrite(relative, page)
            with open(os.path.join(folder, name), "w", encoding="utf-8") as fh:
                fh.write(page)
            pages += 1
            if url:
                urls.append(url)
    listed = sitemap(dist, urls)
    print(f"head: icons and share tags on {pages} pages, {listed} addresses in sitemap.xml")


if __name__ == "__main__":
    main()
