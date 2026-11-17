// Builds the page's pieces from catalogue data: a game card, the filter chips,
// the detail view, the lists of open rooms and the footer's build line. Text
// from the catalogue and from the relay's room list only ever goes in as text
// nodes, never as markup.
import { CI, SOURCE_URL, STATUSES, levelLabel, modeText, multiplayerWords, statusOf } from './model.js';
import { SVG, sprite } from './sprite.js';

export function el(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function glyph(id, name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', name);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export const statusBadge = (status, tag = 'p') =>
  el(tag, { class: `status status-${status.id}` }, glyph(`sig-${status.id}`, 'sig'), el('span', { text: status.label }));

const ciBadge = (ci, tag = 'span') =>
  el(tag, { class: `ci ci-${ci.id}` }, glyph(`ci-${ci.id}`, 'ci-mark'), el('span', { text: ci.label }));

const hidden = (text) => el('span', { class: 'visually-hidden', text });

// "Multiplayer" on a card, for a game two visitors can play over Bluetooth.
// The mark's colour repeats how far that gets here; a screen reader is told.
function multiplayerBadge(multiplayer) {
  return el('span', { class: `mp mp-${multiplayer.status}` }, glyph('mp-players', 'mp-mark'), el('span', { text: 'Multiplayer' }),
    hidden(` over ${modeText('bluetooth', multiplayer.players)}, ${multiplayerWords(multiplayer.status)}`));
}

const byline = (game) => [game.publisher, game.year].filter(Boolean).join(' · ');

// The 176x208 screen: the CI screenshot when there is one, else the game's
// placeholder figure. `eager` is for the detail view, which is opened on purpose.
function screen(game, { eager = false, alt = '' } = {}) {
  const frame = el('div', { class: 'screen' });
  const placeholder = () => {
    frame.classList.add('screen-empty');
    frame.replaceChildren(sprite(game.slug), el('span', { class: 'noshot', 'aria-hidden': 'true', text: 'No screenshot' }));
  };
  if (game.shot) {
    // loading comes before src, so no browser starts the fetch before it knows to wait.
    const img = el('img', { loading: eager ? null : 'lazy', decoding: 'async', width: 176, height: 208, alt, src: game.shot });
    // A status file can name a picture the run never wrote.
    img.addEventListener('error', placeholder, { once: true });
    frame.append(img);
  } else {
    placeholder();
  }
  return frame;
}

export function card(game, onDetails) {
  const status = statusOf(game.status);
  const broken = status.id === 'broken';
  const link = el('a', { class: 'card-link', href: game.playUrl }, game.title,
    broken && el('span', { class: 'visually-hidden', text: ', not working' }));
  const more = el('button', { type: 'button', class: 'more', 'aria-label': `Details for ${game.title}`, 'aria-haspopup': 'dialog', text: 'Details' });
  more.addEventListener('click', () => onDetails(game));
  const by = byline(game);
  const node = el('li', { class: `card card-${status.id}`, 'data-slug': game.slug },
    el('div', { class: 'card-shot' }, screen(game), broken && el('span', { class: 'stamp', 'aria-hidden': 'true', text: 'Not working' })),
    el('h3', { class: 'card-title' }, link),
    game.base && el('p', { class: 'card-variant', text: `Variant of ${game.base.title}` }),
    by && el('p', { class: 'card-by', text: by }),
    statusBadge(status),
    // The multiplayer label and, while someone is hosting the game, how many
    // rooms are open (cardRooms() below).
    el('p', { class: 'card-net', hidden: !game.multiplayer?.bluetooth },
      game.multiplayer?.bluetooth && multiplayerBadge(game.multiplayer),
      el('span', { class: 'card-rooms', hidden: true })),
    el('div', { class: 'card-foot' }, ciBadge(game.ciState), more));
  return node;
}

export function cardRooms(node, count) {
  const line = node.querySelector('.card-net');
  const label = line.querySelector('.card-rooms');
  label.replaceChildren(...(count ? [String(count), hidden(count === 1 ? ' room' : ' rooms'), ' open'] : []));
  label.hidden = !count;
  line.hidden = !count && !line.querySelector('.mp');
}

// One radio button per status plus "All". The counts are filled in by
// setCounts() whenever the search changes.
export function chips(container) {
  const entries = [{ id: '', label: 'All' }, ...STATUSES];
  for (const entry of entries) {
    container.append(el('label', { class: `chip${entry.id ? ` chip-${entry.id}` : ''}` },
      el('input', { type: 'radio', name: 'status', value: entry.id }),
      el('span', { class: 'chip-face' },
        entry.id && glyph(`sig-${entry.id}`, 'sig'),
        el('span', { text: entry.label }),
        el('b', { class: 'chip-count', 'data-count': entry.id || 'all', text: '0' }))));
  }
}

// The one switch beside them: only games that can be played over Bluetooth.
export function multiplayerChip(container) {
  container.append(el('label', { class: 'chip chip-mp' },
    el('input', { type: 'checkbox', name: 'mp', value: '1' }),
    el('span', { class: 'chip-face' },
      glyph('mp-players', 'mp-mark'),
      el('span', { text: 'Multiplayer' }),
      el('b', { class: 'chip-count', 'data-count': 'multiplayer', text: '0' }))));
}

export function setCounts(container, counts, total) {
  for (const badge of container.querySelectorAll('[data-count]')) {
    const count = badge.dataset.count === 'all' ? total : counts[badge.dataset.count];
    badge.textContent = String(count);
    badge.closest('.chip').classList.toggle('chip-none', count === 0);
  }
}

function seconds(value) {
  if (!Number.isFinite(value)) return '';
  return value < 10 ? `${Math.round(value * 10) / 10} s` : `${Math.round(value)} s`;
}

function ciSection(game) {
  const section = el('section', { class: 'detail-block', 'aria-label': 'Automated test' }, ciBadge(game.ciState, 'p'));
  const ci = game.ci;
  if (!ci) {
    section.append(el('p', { text: CI.none.means }));
    return section;
  }
  const took = seconds(ci.seconds);
  section.append(el('p', { text: `The latest run reached "${levelLabel(ci.reached)}"`
    + (ci.expect ? ` and expects "${levelLabel(ci.expect)}"` : '') + (took ? `, in ${took}.` : '.') }));
  if (ci.error) section.append(el('p', { class: 'ci-error' }, el('code', { text: String(ci.error) })));
  return section;
}

function fact(list, term, ...definition) {
  list.append(el('dt', { text: term }), el('dd', null, ...definition));
}

// The ways to play with others, where the game's own menu has them, and how
// far Bluetooth play gets on this site.
function multiplayerFact(multiplayer) {
  return el('div', { class: 'mp-fact' },
    el('ul', { class: 'plain' }, ...multiplayer.modes.map((mode) => el('li', { text: modeText(mode, multiplayer.players) }))),
    multiplayer.menu && el('p', { text: `In the game: ${multiplayer.menu}` }),
    multiplayer.bluetooth && el('p', { text: `Bluetooth play on this site: ${multiplayerWords(multiplayer.status)}.` }),
    multiplayer.statusNote && el('p', { class: 'note', text: multiplayer.statusNote }));
}

// One open room: who hosts it, how full it is, its code, and the link that
// joins it. The game's name is given (`onOpen`) where the list is not about
// one game already. The host's name is a stranger's text: <bdi> keeps a
// right-to-left name from reordering the words around it.
function roomRow(room, game, onOpen) {
  const host = room.host || 'Someone';
  return el('li', { class: 'room', 'data-room': room.room },
    el('div', { class: 'room-text' },
      onOpen && el('p', { class: 'room-game' }, gameLink(game, onOpen)),
      el('p', { class: 'room-meta' },
        el('span', null, 'Hosted by ', el('bdi', { text: host })),
        el('span', { class: 'room-count' }),
        el('code', { text: room.room }))),
    el('a', { class: 'button room-join', href: `${game.playUrl}&room=${room.room}` }, 'Join',
      hidden(` the room ${room.room} hosted by `), el('bdi', { class: 'visually-hidden', text: host }), hidden(`, ${game.title}`)));
}

// Fills a list with rooms. A room that was listed before keeps its row, the
// row stays where it is in the document and only its number of players is
// written anew, so a refresh every half minute does not take the focus away
// from a Join link someone is about to press.
const rows = new WeakMap();
function fillRooms(list, rooms, gameOf, onOpen) {
  const before = rows.get(list) || new Map();
  const now = new Map();
  for (const room of rooms) {
    const key = JSON.stringify([room.room, room.game, room.host]);
    const row = before.get(key) || roomRow(room, gameOf(room), onOpen);
    const counted = row.querySelector('.room-count');
    counted.textContent = room.max ? `${room.players} of ${room.max} players` : '';
    counted.hidden = !room.max;
    now.set(key, row);
  }
  rows.set(list, now);
  const wanted = [...now.values()];
  for (const node of [...list.children]) if (!wanted.includes(node)) node.remove();
  wanted.forEach((node, i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null); });
}

// The page's "Open rooms" section: every open room, newest first; all of them
// only on request when there are many.
const FEW = 6;
export function roomSection(section, rooms, bySlug, onOpen) {
  const list = section.querySelector('.room-list');
  const more = section.querySelector('.rooms-more');
  if (!rooms.length) delete section.dataset.all;
  // A row that has the focus is not cut off by newer rooms arriving above it.
  const focused = list.contains(document.activeElement) ? document.activeElement.closest('.room')?.dataset.room : null;
  if (focused && rooms.findIndex((room) => room.room === focused) >= FEW) section.dataset.all = '';
  const all = 'all' in section.dataset || rooms.length <= FEW;
  // The button is about to go while it has the focus: go on at the last room.
  const stranded = all && document.activeElement === more;
  fillRooms(list, all ? rooms : rooms.slice(0, FEW), (room) => bySlug.get(room.game), onOpen);
  section.querySelector('.rooms-count').textContent = String(rooms.length);
  if (stranded) list.lastElementChild?.querySelector('a')?.focus();
  more.hidden = all;
  more.textContent = `Show all ${rooms.length} rooms`;
  more.onclick = () => {
    section.dataset.all = '';
    roomSection(section, rooms, bySlug, onOpen);
    // The button is gone: go on at the first room it added.
    list.children[FEW]?.querySelector('a')?.focus();
  };
  section.hidden = !rooms.length;
}

// The rooms of the game whose detail view is open.
export function detailRooms(body, game, rooms) {
  const block = body.querySelector('.detail-rooms');
  if (!block) return;
  fillRooms(block.querySelector('.room-list'), rooms, () => game, null);
  block.querySelector('.rooms-heading').textContent = rooms.length === 1 ? '1 open room' : `${rooms.length} open rooms`;
  block.hidden = !rooms.length;
}

// Links between a game and its translations or mods open the other detail view
// in place; `onOpen` does that, and the href is there for opening in a new tab.
function gameLink(game, onOpen) {
  const link = el('a', { href: `/?game=${encodeURIComponent(game.slug)}`, text: game.title });
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(game);
  });
  return link;
}

export function detail(body, game, onOpen, rooms) {
  const status = statusOf(game.status);
  const facts = el('dl', { class: 'facts' });
  if (game.genre) fact(facts, 'Genre', game.genre);
  if (game.base) fact(facts, 'Variant of', gameLink(game.base, onOpen));
  if (game.variants.length) {
    fact(facts, game.variants.length > 1 ? 'Variants' : 'Variant',
      el('ul', { class: 'plain' }, ...game.variants.map((variant) => el('li', null, gameLink(variant, onOpen)))));
  }
  if (game.multiplayer) fact(facts, 'Multiplayer', multiplayerFact(game.multiplayer));
  fact(facts, 'Controls', game.hasControls ? 'Laid out for this game' : 'Standard N-Gage layout');
  if (game.uid) fact(facts, 'App UID', el('code', { text: game.uid }));

  const by = byline(game);
  body.replaceChildren(
    el('div', { class: 'detail-shot' }, screen(game, { eager: true, alt: `Screenshot of ${game.title} from the latest automated run` })),
    el('div', { class: 'detail-text' },
      el('h2', { id: 'detail-title', class: 'detail-title', tabindex: '-1', text: game.title }),
      by && el('p', { class: 'detail-by', text: by }),
      el('section', { class: 'detail-block', 'aria-label': 'Status' },
        statusBadge(status),
        el('p', { text: status.means }),
        game.statusNote && el('p', { class: 'note', text: game.statusNote })),
      el('section', { class: 'detail-block detail-rooms', 'aria-label': 'Open rooms', hidden: true },
        el('p', { class: 'rooms-heading' }),
        el('ul', { class: 'room-list' })),
      ciSection(game),
      facts,
      el('div', { class: 'detail-actions' },
        el('a', { class: 'button primary', href: game.playUrl, text: status.id === 'broken' ? 'Try it anyway' : 'Play' }),
        el('form', { method: 'dialog' }, el('button', { class: 'button', text: 'Close' })))));
  detailRooms(body, game, rooms);
}

const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });

// "Test results from 16 November 2026 at 14:03 UTC, commit 3dd372a."
export function buildLine(node, { generated, commit }) {
  if (!generated && !commit) {
    node.replaceChildren('This build of the site carries no automated test results yet.');
    return;
  }
  const parts = ['Test results '];
  if (generated) parts.push('from ', el('time', { datetime: generated.toISOString(), text: `${WHEN.format(generated)} UTC` }));
  if (commit) {
    parts.push(generated ? ', commit ' : 'for commit ',
      el('a', { href: `${SOURCE_URL}/commit/${commit}` }, el('code', { text: commit.slice(0, 7) })));
  }
  parts.push('.');
  node.replaceChildren(...parts);
}
