import { describe, expect, it } from 'vitest';
import { describe as describeGame, handle } from '../src/index.js';

// The head that tools/site/steps/70-head.py writes, cut down.
const PAGE = `<!doctype html><html><head>
<title>n-ga.ge</title>
<meta name="description" content="The player.">
<link rel="canonical" href="https://n-ga.ge/play/">
<meta property="og:title" content="Play an N-Gage game · n-ga.ge">
<meta property="og:description" content="The player.">
<meta property="og:url" content="https://n-ga.ge/play/">
<meta property="og:image" content="https://n-ga.ge/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The site.">
<meta name="twitter:card" content="summary_large_image">
</head><body>player</body></html>`;

const CATALOG = {
  games: [
    { slug: 'ashen', title: 'Ashen & Co "2"', publisher: 'Nokia', year: 2004, genre: 'First-person shooter', status: 'ingame',
      statusNote: 'Chapter 1 plays.', ci: { pass: true, shot: 'shots/ashen.png' } },
    { slug: 'quiet', title: 'Quiet', status: 'menu', statusNote: 'x '.repeat(200) },
  ],
};

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'",
  'Cache-Control': 'public, max-age=0, must-revalidate',
  ETag: '"abc"',
};

// The Pages site: the page on / and /play/, the catalogue, 404 for the rest.
function site({ catalog = CATALOG, page = PAGE, status = 200 } = {}) {
  const seen = [];
  const origin = async (request) => {
    const url = new URL(request.url);
    seen.push(url.pathname + url.search);
    if (url.pathname === '/catalog/index.json') {
      return catalog ? Response.json(catalog) : new Response('no', { status: 404 });
    }
    if (url.pathname === '/' || url.pathname === '/play/') return new Response(page, { status, headers: HEADERS });
    return new Response('not found', { status: 404 });
  };
  return { origin, seen };
}

const tag = (html, selector) => html.match(new RegExp(`<[^>]*${selector}[^>]*>`))?.[0] || '';
const contentOf = (html, selector) => tag(html, selector).match(/content="([^"]*)"/)?.[1];

describe('a link to one game', () => {
  it('previews the game on the player', async () => {
    const { origin } = site();
    const response = await handle(new Request('https://n-ga.ge/play/?g=ashen'), origin);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(contentOf(html, 'property="og:title"')).toBe('Ashen &amp; Co &quot;2&quot; · n-ga.ge');
    expect(contentOf(html, 'property="og:description"')).toBe(
      'N-Gage · 2004 · First-person shooter · Nokia. Playable in the browser: Chapter 1 plays.');
    expect(contentOf(html, 'name="description"')).toBe(contentOf(html, 'property="og:description"'));
    expect(contentOf(html, 'property="og:url"')).toBe('https://n-ga.ge/play/?g=ashen');
    expect(tag(html, 'rel="canonical"')).toContain('href="https://n-ga.ge/play/?g=ashen"');
    expect(contentOf(html, 'property="og:image"')).toBe('https://n-ga.ge/catalog/shots/ashen.png');
    expect(contentOf(html, 'property="og:image:width"')).toBe('176');
    expect(contentOf(html, 'property="og:image:height"')).toBe('208');
    expect(contentOf(html, 'name="twitter:card"')).toBe('summary');
    // The page names the running game in its title itself.
    expect(html).toContain('<title>n-ga.ge</title>');
  });

  it('keeps the headers Pages sent, but not the validator of the old body', async () => {
    const { origin } = site();
    const response = await handle(new Request('https://n-ga.ge/play/?g=ashen'), origin);
    for (const name of ['Cross-Origin-Embedder-Policy', 'Cross-Origin-Opener-Policy', 'Content-Security-Policy', 'Cache-Control', 'Content-Type']) {
      expect(response.headers.get(name)).toBe(HEADERS[name]);
    }
    expect(response.headers.get('ETag')).toBeNull();
  });

  it('previews the game on the front page, whose canonical address stays the front page', async () => {
    const { origin } = site();
    const html = await (await handle(new Request('https://dev.n-ga.ge/?game=ashen&q=x'), origin)).text();
    expect(contentOf(html, 'property="og:url"')).toBe('https://dev.n-ga.ge/?game=ashen');
    expect(contentOf(html, 'property="og:image"')).toBe('https://dev.n-ga.ge/catalog/shots/ashen.png');
    expect(tag(html, 'rel="canonical"')).toContain('href="https://n-ga.ge/play/"');
  });

  it('keeps the site picture for a game without a screenshot, and cuts a long note', async () => {
    const { origin } = site();
    const html = await (await handle(new Request('https://n-ga.ge/play/?g=quiet'), origin)).text();
    const description = contentOf(html, 'property="og:description"');
    expect(description.startsWith('N-Gage game. Gets to its menus in the browser: x x')).toBe(true);
    expect(description.length).toBeLessThanOrEqual(220);
    expect(description.endsWith('…')).toBe(true);
    expect(contentOf(html, 'property="og:image"')).toBe('https://n-ga.ge/og.png');
    expect(contentOf(html, 'name="twitter:card"')).toBe('summary_large_image');
  });
});

describe('everything else passes through unchanged', () => {
  const cases = [
    ['no game', 'https://n-ga.ge/play/'],
    ['the other page\'s parameter', 'https://n-ga.ge/play/?game=ashen'],
    ['a slug that is not one', 'https://n-ga.ge/play/?g=..%2Fx'],
    ['a game the catalogue does not have', 'https://n-ga.ge/play/?g=nothing'],
    ['another path', 'https://n-ga.ge/docs/?g=ashen'],
  ];
  for (const [name, address] of cases) {
    it(name, async () => {
      const { origin } = site();
      const response = await handle(new Request(address), origin);
      if (response.status === 200) {
        expect(await response.text()).toBe(PAGE);
        expect(response.headers.get('ETag')).toBe('"abc"');
      }
    });
  }

  it('asks nothing more than the page for an address without a game', async () => {
    const { origin, seen } = site();
    await handle(new Request('https://n-ga.ge/'), origin);
    expect(seen).toEqual(['/']);
  });

  it('a HEAD request', async () => {
    const { origin, seen } = site();
    await handle(new Request('https://n-ga.ge/play/?g=ashen', { method: 'HEAD' }), origin);
    expect(seen).toEqual(['/play/?g=ashen']);
  });

  it('a page that is not 200, and a catalogue that cannot be read', async () => {
    let { origin } = site({ status: 304, page: null });
    expect((await handle(new Request('https://n-ga.ge/play/?g=ashen'), origin)).status).toBe(304);
    ({ origin } = site({ catalog: null }));
    expect(await (await handle(new Request('https://n-ga.ge/play/?g=ashen'), origin)).text()).toBe(PAGE);
  });
});

describe('describe()', () => {
  it('leaves out facts the catalogue does not have', () => {
    expect(describeGame({ slug: 'a', title: 'A', status: 'boots' }, 'https://n-ga.ge', '/play/').description)
      .toBe('N-Gage game. Starts in the browser.');
  });
  it('ignores a screenshot path that is not one', () => {
    expect(describeGame({ slug: 'a', title: 'A', ci: { shot: '../x.png' } }, 'https://n-ga.ge', '/').image).toBeNull();
  });
});
