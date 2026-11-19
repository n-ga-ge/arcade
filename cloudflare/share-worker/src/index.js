// Link previews for one game. A link to a game is /play/?g=<slug>, the
// player, and that is the same static page for every game; a chat or social
// site reading the link runs no script, so without this Worker every game
// would preview as the site. The Worker's route is /play/* (a route matches
// the whole URL, query string included, so /play/ alone would never match a
// link to a game). It passes every request to the Pages site, and only for
// /play/?g=<known slug> rewrites, in the page Pages answered, the share tags that
// tools/site/steps/70-head.py put there: title, description, address and
// picture (the game's CI screenshot). README.md has the rest.
//
// Nothing else changes: the response keeps every header Pages gave it (the
// cross-origin isolation, the Content-Security-Policy, the caching), the page
// keeps its <title> (the player names the running game itself), and any
// failure, a slug the catalogue does not know included, returns the page as
// Pages sent it.

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The page whose links name a game, and the parameter that names it.
const PAGE = '/play/';
const PARAMETER = 'g';
// What each status level (site/js/model.js) means, as the start of a sentence.
const STATUS = {
  ingame: 'Playable in the browser',
  menu: 'Gets to its menus in the browser',
  boots: 'Starts in the browser',
  broken: 'Does not work in the browser yet',
  untested: 'Not tried in the browser yet',
};
const SITE_NAME = 'n-ga.ge';
// The screenshots CI takes are the N-Gage's screen, 176x208.
const SHOT = { width: 176, height: 208 };
const DESCRIPTION_LIMIT = 220;

function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1).replace(/\s+\S*$/, '').replace(/[,;:]$/, '') + '…';
}

// What the preview says about a game, from its summary in /catalog/index.json.
export function describe(game, origin) {
  const facts = [game.year, game.genre, game.publisher].filter(Boolean).join(' · ');
  const status = STATUS[game.status] || STATUS.untested;
  const lead = `${facts ? `N-Gage · ${facts}` : 'N-Gage game'}. ${status}`;
  const note = game.statusNote ? `: ${game.statusNote}` : '.';
  const shot = game.ci && typeof game.ci.shot === 'string' && /^shots\/[a-z0-9-]+\.png$/.test(game.ci.shot) ? game.ci.shot : null;
  const url = `${origin}${PAGE}?${PARAMETER}=${game.slug}`;
  return {
    title: `${game.title} · ${SITE_NAME}`,
    description: clip(lead + note, DESCRIPTION_LIMIT),
    url,
    image: shot ? { url: `${origin}/catalog/${shot}`, ...SHOT, alt: `${game.title} running on n-ga.ge` } : null,
  };
}

// HTMLRewriter escapes only the quote in an attribute value; a bare "&" could
// still be read as the start of a character reference ("&copy" in a title).
const escapeAmpersands = (value) => String(value).replace(/&/g, '&amp;');

function content(value) {
  return { element(element) { element.setAttribute('content', escapeAmpersands(value)); } };
}

export function rewrite(page, share) {
  let rewriter = new HTMLRewriter()
    .on('meta[name="description"]', content(share.description))
    .on('meta[property="og:title"]', content(share.title))
    .on('meta[property="og:description"]', content(share.description))
    .on('meta[property="og:url"]', content(share.url))
    .on('link[rel="canonical"]', {
      element(element) {
        const href = element.getAttribute('href');
        if (!href) return;
        try {
          const target = new URL(href);
          const shared = new URL(share.url);
          element.setAttribute('href', escapeAmpersands(`${target.origin}${shared.pathname}${shared.search}`));
        } catch { /* leave it */ }
      },
    });
  if (share.image) {
    // A portrait screenshot is a thumbnail beside the text, not a wide banner.
    rewriter = rewriter
      .on('meta[property="og:image"]', content(share.image.url))
      .on('meta[property="og:image:width"]', content(share.image.width))
      .on('meta[property="og:image:height"]', content(share.image.height))
      .on('meta[property="og:image:alt"]', content(share.image.alt))
      .on('meta[name="twitter:card"]', content('summary'));
  }
  const response = rewriter.transform(page);
  const headers = new Headers(response.headers);
  // The body is no longer the one these validate.
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// `origin` fetches from the Pages site: the global fetch in production (a
// Worker's request to its own zone skips the Worker), a stand-in in tests.
export async function handle(request, origin = fetch) {
  const url = new URL(request.url);
  // The player's own files under /play/ go straight through.
  const slug = url.pathname === PAGE ? url.searchParams.get(PARAMETER) : null;
  if (request.method !== 'GET' || !slug || !SLUG.test(slug)) return origin(request);

  const page = await origin(request);
  if (page.status !== 200 || !(page.headers.get('Content-Type') || '').includes('text/html')) return page;
  try {
    const index = await origin(new Request(`${url.origin}/catalog/index.json`, { headers: { Accept: 'application/json' } }));
    if (!index.ok) return page;
    const catalog = await index.json();
    const game = (catalog.games || []).find((entry) => entry.slug === slug);
    if (!game || !game.title) return page;
    return rewrite(page, describe(game, url.origin));
  } catch {
    return page;
  }
}

export default {
  async fetch(request, env, ctx) {
    // If the Worker itself throws, the request goes to the site unchanged.
    ctx.passThroughOnException();
    return handle(request);
  },
};
