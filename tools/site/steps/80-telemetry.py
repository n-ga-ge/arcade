#!/usr/bin/env python3
"""Site build step: add the visitor statistics (Umami) to every page.

  python3 -I 80-telemetry.py <output folder>      (run by tools/site/build.py)

Every .html file in the tree (the front page, 404.html, the player at /play/,
the pages under /docs/) gets two scripts from telemetry.bad.cash before its
</head>: meow.js, Umami's page-view tracker, and recorder.js, its session
recorder (rrweb, canvas not recorded). The player's page comes from the fork,
which must not depend on the site, so the tags are added here and not in the
page sources.

Two things the site's headers require of them (cloudflare/pages/_headers):

- crossorigin="anonymous". The site is cross-origin isolated (COEP
  require-corp), so a script of another origin loads only with a CORP header,
  which telemetry.bad.cash does not send, or as a CORS request, which it
  answers with "Access-Control-Allow-Origin: *".
- https://telemetry.bad.cash in script-src of both Content-Security-Policy
  lines. What the scripts send goes to the same host, which connect-src
  https: already allows; the recorder's worker is a blob:, which worker-src
  allows.

data-domains limits the tracker to the production host, so local builds, the
dev server, CI and the dev deployment report nothing. The recorder waits for
the tracker's session and gives up without one, so it follows the same rule.

The build stops when a page has no </head>, so that no page goes out without
the scripts by accident. A page that already names meow.js is left alone.
"""
import os
import sys

HOST = "https://telemetry.bad.cash"
WEBSITE = "2da87393-b465-4562-9763-9b57d003807c"
DOMAINS = "n-ga.ge"

TAGS = (
    f'<script defer src="{HOST}/meow.js" crossorigin="anonymous" data-website-id="{WEBSITE}" data-domains="{DOMAINS}"></script>\n'
    f'<script defer src="{HOST}/recorder.js" crossorigin="anonymous" data-website-id="{WEBSITE}"></script>\n'
)


def main():
    out = sys.argv[1]
    pages, missing = 0, []
    for folder, _, files in os.walk(out):
        for name in sorted(files):
            if not name.endswith(".html"):
                continue
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            if f"{HOST}/meow.js" in text:
                continue
            at = text.lower().find("</head>")
            if at < 0:
                missing.append(os.path.relpath(path, out))
                continue
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text[:at] + TAGS + text[at:])
            pages += 1
    if missing:
        sys.exit("80-telemetry: no </head> to put the statistics scripts before in " + ", ".join(missing))
    print(f"80-telemetry: statistics scripts added to {pages} pages")


if __name__ == "__main__":
    main()
