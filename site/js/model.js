// The catalogue as the front page sees it: loading /catalog/index.json, the
// status vocabulary, searching, filtering and ordering. No DOM in here.

export const CATALOG_URL = '/catalog/';
export const SOURCE_URL = 'https://github.com/n-ga.ge/arcade';

// Best first: this is also the default order of the page and of the filter.
export const STATUSES = [
  { id: 'ingame', label: 'Playable', means: 'Gets into the game and can be played.' },
  { id: 'menu', label: 'Menus only', means: 'The main menu works, but the game itself does not start.' },
  { id: 'boots', label: 'Boots', means: 'Shows its own first screens and gets no further.' },
  { id: 'broken', label: 'Not working', means: 'Does not start, or crashes.' },
];
// A game nobody has looked at yet is in the catalogue but not on the page: the
// site only lists games it can say something about.
const UNTESTED = { id: 'untested', label: 'Untested', means: 'Nobody has tried it in the web build yet.' };
const RANK = new Map(STATUSES.map((status, i) => [status.id, i]));
const BY_ID = new Map([...STATUSES, UNTESTED].map((status) => [status.id, status]));

export const statusOf = (id) => BY_ID.get(id) || UNTESTED;

// The words for a level a test run reached or expected. The runner can report
// levels the catalogue has no word for (nothing shown at all), so fall back to
// what it said.
export const levelLabel = (id) => (BY_ID.has(id) ? BY_ID.get(id).label : id ? String(id) : 'nothing');

export const CI = {
  pass: { id: 'pass', label: 'CI passing' },
  fail: { id: 'fail', label: 'CI failing' },
  none: { id: 'none', label: 'CI not run', means: 'No automated run has been recorded for this game.' },
};

// Case and accents do not matter when searching ("pokemon" finds "Pokémon").
const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function normalise(raw, version) {
  const ci = raw.ci && typeof raw.ci === 'object' ? raw.ci : null;
  const game = {
    slug: String(raw.slug),
    title: String(raw.title || raw.slug),
    uid: raw.uid ? String(raw.uid) : '',
    status: statusOf(raw.status).id,
    statusNote: raw.statusNote ? String(raw.statusNote) : '',
    publisher: raw.publisher ? String(raw.publisher) : '',
    year: Number.isFinite(raw.year) ? raw.year : null,
    genre: raw.genre ? String(raw.genre) : '',
    variantOf: raw.variantOf ? String(raw.variantOf) : null,
    hasControls: Boolean(raw.hasControls),
    ci,
    ciState: !ci ? CI.none : ci.pass === true ? CI.pass : CI.fail,
    shot: null,
    base: null,
    variants: [],
  };
  if (ci && typeof ci.shot === 'string' && ci.shot && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ci.shot)) {
    // A new CI run replaces the picture under the same name, so the address
    // carries the run it came from and a cached copy is not shown for it.
    game.shot = CATALOG_URL + ci.shot.replace(/^\/+/, '') + (version ? `?v=${encodeURIComponent(version)}` : '');
  }
  game.playUrl = `/play/?g=${encodeURIComponent(game.slug)}`;
  game.haystack = fold([game.title, game.publisher, game.genre, game.year || '', game.slug.replace(/-/g, ' ')].join(' '));
  return game;
}

export async function loadCatalog(signal) {
  const response = await fetch(`${CATALOG_URL}index.json`, { signal });
  if (!response.ok) throw new Error(`the server answered ${response.status}`);
  let index;
  try {
    index = await response.json();
  } catch {
    throw new Error('the catalogue file is not valid JSON');
  }
  if (!index || !Array.isArray(index.games)) throw new Error('the catalogue file has no list of games');
  const commit = typeof index.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(index.commit) ? index.commit : null;
  const version = commit ? commit.slice(0, 12) : index.generated ? String(index.generated) : '';
  const games = index.games.filter((raw) => raw && raw.slug).map((raw) => normalise(raw, version))
    .filter((game) => game.status !== UNTESTED.id);
  const bySlug = new Map(games.map((game) => [game.slug, game]));
  for (const game of games) {
    const base = game.variantOf && game.variantOf !== game.slug ? bySlug.get(game.variantOf) : null;
    if (base) {
      game.base = base;
      base.variants.push(game);
    }
  }
  return { games, bySlug, commit, generated: parseDate(index.generated) };
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  // Seconds since 1970 as well as an ISO string: whichever the CI script writes.
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
// "The Sims" files under S, as on a shelf.
const sortTitle = (game) => game.title.replace(/^(the|a|an)\s+/i, '');
const byTitle = (a, b) => collator.compare(sortTitle(a), sortTitle(b)) || collator.compare(a.slug, b.slug);
const ORDERS = {
  '': (a, b) => RANK.get(a.status) - RANK.get(b.status) || byTitle(a, b),
  title: byTitle,
};
export const isOrder = (name) => Object.hasOwn(ORDERS, name);
export const isStatus = (id) => RANK.has(id);


// What the page shows for a search, status filter and order, plus how many of
// the searched games have each status (the numbers on the filter).
export function select(games, { q, status, sort }) {
  // Every word typed has to appear somewhere in the title, publisher, genre or year.
  const words = fold(q).split(/\s+/).filter(Boolean);
  const found = games.filter((game) => words.every((word) => game.haystack.includes(word)));
  const counts = Object.fromEntries(STATUSES.map((entry) => [entry.id, 0]));
  for (const game of found) counts[game.status] += 1;
  const shown = (status ? found.filter((game) => game.status === status) : found).sort(ORDERS[isOrder(sort) ? sort : '']);
  return { shown, counts, found: found.length };
}
