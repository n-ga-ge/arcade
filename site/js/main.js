// The front page: loads the catalogue, shows a card per game, and keeps the
// search, status filter, order and open detail view in the address so a view
// can be shared.
//
//   ?q=<text>  &status=<ingame|menu|boots|broken|untested>  &sort=title  &game=<slug>
import { isOrder, isStatus, loadCatalog, select, statusOf } from './model.js';
import { buildLine, card, chips, detail, el, setCounts } from './view.js';

const $ = (id) => document.getElementById(id);
const notice = $('notice');
const browse = $('browse');
const grid = $('grid');
const empty = $('empty');
const summary = $('summary');
const search = $('q');
const order = $('sort');
const chipBox = $('chips');
const dialog = $('detail');
const dialogBody = $('detail-body');

let catalog = null;
// Set while the close of a detail view steps back through history: the button
// that opened it, which has the focus again by then.
let closing = null;
const cards = new Map();
const state = { q: '', status: '', sort: '', game: '' };

function readAddress() {
  const params = new URLSearchParams(location.search);
  state.q = params.get('q') || '';
  state.status = isStatus(params.get('status')) ? params.get('status') : '';
  state.sort = params.get('sort') && isOrder(params.get('sort')) ? params.get('sort') : '';
  state.game = params.get('game') || '';
}

// Puts the state in the address, leaving parameters that are not this page's
// alone. Search and filters replace the current history entry (typing must not
// leave a trail behind the Back button); opening a detail view adds one, so
// Back closes it. `details` counts the entries added that way.
function writeAddress({ push = false } = {}) {
  const params = new URLSearchParams(location.search);
  for (const [name, value] of Object.entries(state)) {
    const text = name === 'q' ? value.trim() : value;
    if (text) params.set(name, text);
    else params.delete(name);
  }
  const query = params.toString();
  const target = location.pathname + (query ? `?${query}` : '') + location.hash;
  if (target === location.pathname + location.search + location.hash) return;
  const details = (history.state && history.state.details) || 0;
  try {
    if (push) history.pushState({ details: details + 1 }, '', target);
    else history.replaceState(history.state, '', target);
  } catch {
    // Safari refuses more than 100 history calls in 30 seconds. The page is
    // right either way; only the address lags until the next change.
  }
}

function showNotice(title, ...lines) {
  notice.replaceChildren(el('p', { class: 'notice-title', text: title }), ...lines);
  notice.hidden = false;
}

function render() {
  const { shown, counts, found } = select(catalog.games, state);
  setCounts(chipBox, counts, found);
  // Only the matching cards stay in the document, in order, so the tab order
  // and what a screen reader lists are what is on screen.
  const wanted = shown.map((game) => cards.get(game.slug));
  if (wanted.length !== grid.children.length || wanted.some((node, i) => node !== grid.children[i])) grid.replaceChildren(...wanted);
  empty.hidden = shown.length > 0;
  const total = catalog.games.length;
  const query = state.q.trim();
  // "62 games", or "3 of 62 games: playable, matching "rally"".
  const limits = [state.status && statusOf(state.status).label.toLowerCase(), query && `matching "${query}"`].filter(Boolean);
  summary.textContent = limits.length
    ? `${shown.length} of ${total} games: ${limits.join(', ')}`
    : `${total} ${total === 1 ? 'game' : 'games'}`;
}

function syncControls() {
  search.value = state.q;
  order.value = state.sort;
  for (const radio of chipBox.querySelectorAll('input')) radio.checked = radio.value === state.status;
}

function update() {
  render();
  writeAddress();
}

function showDetail(game) {
  detail(dialogBody, game, openDetail);
  if (!dialog.open) dialog.showModal();
  dialogBody.scrollTop = 0;
  // Start reading at the title rather than at the first link inside.
  dialogBody.querySelector('#detail-title').focus();
}

// A detail view opened from the page (a card's button, a variant's link).
function openDetail(game) {
  state.game = game.slug;
  writeAddress({ push: true });
  showDetail(game);
}

// The address changed under us (Back, Forward): show what it says.
function followAddress() {
  readAddress();
  if (closing) {
    // Stepping back from a closed detail view can land on the shared address
    // that opened the first one; it stays closed.
    const invoker = closing;
    closing = null;
    state.game = '';
    writeAddress();
    // When the address ends in #games (the skip link was used), stepping back
    // moves the focus to the start of the list. Put it back on the button.
    const refocus = () => { if (invoker.isConnected && document.activeElement !== invoker) invoker.focus({ preventScroll: true }); };
    refocus();
    setTimeout(refocus, 0);
  }
  syncControls();
  render();
  const game = catalog.bySlug.get(state.game);
  if (game) showDetail(game);
  else {
    state.game = '';
    if (dialog.open) dialog.close();
  }
}

function wire() {
  search.addEventListener('input', () => { state.q = search.value; update(); });
  $('controls').addEventListener('submit', (event) => { event.preventDefault(); search.blur(); });
  order.addEventListener('change', () => { state.sort = order.value; update(); });
  chipBox.addEventListener('change', (event) => { state.status = event.target.value; update(); });
  $('reset').addEventListener('click', () => {
    state.q = '';
    state.status = '';
    syncControls();
    update();
    search.focus();
  });

  dialog.addEventListener('close', () => {
    if (!state.game) return;   // closed by followAddress(): the address is already right
    state.game = '';
    const details = (history.state && history.state.details) || 0;
    // Step back over the entries the detail views added, so Back does not
    // reopen what was just closed. A view opened straight from a shared
    // address added none; there the address is only tidied.
    if (details) {
      closing = document.activeElement || document.body;
      history.go(-details);
    } else {
      writeAddress();
    }
  });
  // A click on the backdrop lands on the dialog element itself. Both ends of
  // the click have to be out there: a text selection dragged out of the dialog
  // must not close it.
  let pressedOutside = false;
  const outside = (event) => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog
      && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  dialog.addEventListener('pointerdown', (event) => { pressedOutside = outside(event); });
  dialog.addEventListener('click', (event) => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || dialog.open) return;
    if (event.target.closest('input, select, textarea, [contenteditable]')) return;
    event.preventDefault();
    search.focus();
    search.select();
  });
  window.addEventListener('popstate', followAddress);
}

async function start() {
  readAddress();
  // Only say "loading" when it takes long enough to notice.
  const slow = setTimeout(() => showNotice('Loading the catalogue…'), 400);
  try {
    catalog = await loadCatalog();
  } catch (error) {
    clearTimeout(slow);
    const retry = el('button', { type: 'button', class: 'button', text: 'Try again' });
    retry.addEventListener('click', () => location.reload());
    showNotice('The list of games could not be loaded.',
      el('p', { text: `The catalogue file did not arrive: ${error.message || error}. The emulator itself does not need it.` }),
      el('p', { class: 'notice-actions' }, retry, el('a', { class: 'button', href: '/play/', text: 'Load your own game' })));
    notice.classList.add('notice-error');
    return;
  }
  clearTimeout(slow);
  notice.hidden = true;
  buildLine($('build'), catalog);
  if (!catalog.games.length) {
    showNotice('The catalogue is empty.', el('p', null, 'There are no games listed yet. You can still ',
      el('a', { href: '/play/', text: 'load your own game' }), '.'));
    return;
  }
  chips(chipBox);
  for (const game of catalog.games) cards.set(game.slug, card(game, openDetail));
  wire();
  syncControls();
  browse.hidden = false;
  render();
  const game = catalog.bySlug.get(state.game);
  if (game) showDetail(game);
  else if (state.game) { state.game = ''; writeAddress(); }
}

start();
