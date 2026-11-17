// The open rooms of the multiplayer relay: asking /net/rooms for them and
// checking what comes back. No DOM in here.
//
// A room is opened by a visitor in the player, and the list is whatever the
// relay says: every field of a record is text typed by a stranger or could be
// forged to look like it. Nothing leaves this file unchecked, and the page
// only ever puts it in as text.

export const ROOMS_URL = '/net/rooms';
const PERIOD = 30000;
// Where the address answers 404 there is no relay (a local build, a site that
// has none yet): asking every half minute would only fill the browser's
// console, so the page looks again much later.
const PERIOD_ABSENT = 300000;
const PATIENCE = 10000;
const MOST = 50;
const NAME = 24;

// A room code is six characters of an alphabet without the look-alikes
// (0 and O, 1 and I); a game is a catalogue slug.
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const SLUG = /^[a-z0-9-]{1,64}$/;

const count = (value) => (Number.isInteger(value) && value >= 1 && value <= 255 ? value : null);

// The relay trims names and removes control characters; do not rely on it.
// The characters that override the direction of text go too (a name must not
// be able to rearrange how it reads), and a name of nothing but invisible
// characters is no name.
function cleanName(value) {
  if (typeof value !== 'string') return '';
  const name = [...value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME).join('').trim();
  return name.replace(/[\p{Cf}\p{Z}ᅟᅠ⠀ㅤﾠ]/gu, '') ? name : '';
}

function cleanRoom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.room !== 'string' || !CODE.test(raw.room)) return null;
  if (typeof raw.game !== 'string' || !SLUG.test(raw.game)) return null;
  const players = count(raw.players);
  const max = count(raw.max);
  const counted = players !== null && max !== null && players <= max;
  return { room: raw.room, game: raw.game, host: cleanName(raw.host), players: counted ? players : null, max: counted ? max : null };
}

// The rooms in an answer of the relay, in its order (newest first), each code
// once. Throws when the answer is not a list of rooms at all.
export function cleanRooms(answer) {
  if (!answer || !Array.isArray(answer.rooms)) throw new Error('no list of rooms');
  const seen = new Set();
  const rooms = [];
  for (const raw of answer.rooms) {
    const room = cleanRoom(raw);
    if (!room || seen.has(room.room)) continue;
    seen.add(room.room);
    rooms.push(room);
    if (rooms.length === MOST) break;
  }
  return rooms;
}

// One request. Never throws. `rooms` is the list, or null when no list could
// be had this time; `absent` says there is no relay at this address at all.
async function ask() {
  const control = new AbortController();
  const patience = setTimeout(() => control.abort(), PATIENCE);
  try {
    const response = await fetch(ROOMS_URL, { cache: 'no-store', signal: control.signal });
    if (!response.ok) return { rooms: null, absent: response.status === 404 };
    return { rooms: cleanRooms(await response.json()), absent: false };
  } catch {
    return { rooms: null, absent: false };
  } finally {
    clearTimeout(patience);
  }
}

// Asks now and then every 30 seconds while the page is visible, calling
// `show(rooms)` with each list. A page that comes back into view after a
// longer time asks at once. One request that fails leaves the last list on
// the page, so a hiccup does not make the rooms blink; a second in a row, or
// an answer that there is no relay, empties it.
export function watchRooms(show) {
  let timer = 0;
  let asked = 0;
  let busy = false;
  let period = PERIOD;
  let failures = 0;
  const plan = () => {
    clearTimeout(timer);
    timer = 0;
    if (busy || document.visibilityState !== 'visible') return;
    timer = setTimeout(refresh, Math.max(0, asked + period - Date.now()));
  };
  const refresh = async () => {
    if (busy) return;
    busy = true;
    const answer = await ask();
    busy = false;
    asked = Date.now();
    period = answer.absent ? PERIOD_ABSENT : PERIOD;
    failures = answer.rooms ? 0 : failures + 1;
    try {
      if (answer.rooms) show(answer.rooms);
      else if (answer.absent || failures > 1) show([]);
    } finally {
      plan();
    }
  };
  document.addEventListener('visibilitychange', plan);
  refresh();
}
