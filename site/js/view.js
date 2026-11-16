// Builds the page's pieces from catalogue data: a game card, the filter chips,
// the detail view and the footer's build line. Text from the catalogue only
// ever goes in as text nodes, never as markup.
import { CI, SOURCE_URL, STATUSES, levelLabel, statusOf } from './model.js';
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
    el('div', { class: 'card-foot' }, ciBadge(game.ciState), more));
  return node;
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

export function detail(body, game, onOpen) {
  const status = statusOf(game.status);
  const facts = el('dl', { class: 'facts' });
  if (game.genre) fact(facts, 'Genre', game.genre);
  if (game.base) fact(facts, 'Variant of', gameLink(game.base, onOpen));
  if (game.variants.length) {
    fact(facts, game.variants.length > 1 ? 'Variants' : 'Variant',
      el('ul', { class: 'plain' }, ...game.variants.map((variant) => el('li', null, gameLink(variant, onOpen)))));
  }
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
      ciSection(game),
      facts,
      el('div', { class: 'detail-actions' },
        el('a', { class: 'button primary', href: game.playUrl, text: status.id === 'broken' ? 'Try it anyway' : 'Play' }),
        el('form', { method: 'dialog' }, el('button', { class: 'button', text: 'Close' })))));
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
