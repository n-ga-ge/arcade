// The numbers and the input rules of the relay protocol, version 1. README.md
// describes the protocol; these are the places where a value from a stranger
// is turned into something the relay stores or sends on.

export const VERSION = 1;
// Members of one room at a time.
export const MAX_MEMBERS = 8;
// Ids are 1 to 255 and never reused while the room lives.
export const LAST_ID = 255;
// A binary frame is one destination byte and 1 to 32768 payload bytes.
export const MAX_PAYLOAD = 32768;
export const MAX_FRAME = 1 + MAX_PAYLOAD;
// More frames than this from one connection within a second closes it.
export const MAX_FRAMES_PER_SECOND = 2000;
// A text frame the relay acts on is far shorter; a longer one is not parsed.
export const MAX_TEXT = 256;
export const MAX_NAME = 24;
// What GET /net/rooms returns at most.
export const MAX_LISTED = 50;

// The error codes a refused connection is told, with the WebSocket close code
// that follows the message.
export const CLOSE = {
  'bad-request': 4400,
  'no-room': 4404,
  'room-exists': 4409,
  'room-full': 4413,
  'too-fast': 4429,
};
export const TOO_BIG = 1009;

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const GAME = /^[a-z0-9-]{1,64}$/;

// The room code in upper case, or null when it is not one.
export function roomCode(value) {
  const code = String(value ?? '').toUpperCase();
  return CODE.test(code) ? code : null;
}

export function isGame(value) {
  return typeof value === 'string' && GAME.test(value);
}

// A player's name as the relay keeps and sends it: without control characters,
// trimmed, 1 to 24 characters (code points). Null when nothing usable is left.
export function playerName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\p{Cc}/gu, '').trim();
  const length = [...name].length;
  return length >= 1 && length <= MAX_NAME ? name : null;
}

// What a connection asks for, from the path's code and the query. Returns
// { code, name, create, game, isPublic }, or { error } with the text for the
// client: every one of these is a "bad-request".
export function parseJoin(pathCode, query) {
  if (query.get('v') !== String(VERSION)) return { error: `this relay speaks protocol version ${VERSION} (v=${VERSION})` };
  const code = roomCode(pathCode);
  if (code === null) return { error: 'a room code is 6 of the characters ABCDEFGHJKLMNPQRSTUVWXYZ23456789' };
  const name = playerName(query.get('name'));
  if (name === null) return { error: `a name of 1 to ${MAX_NAME} characters is required` };
  const create = query.get('create') === '1';
  if (!create) return { code, name, create, game: null, isPublic: false };
  const game = query.get('game');
  if (!isGame(game)) return { error: 'creating a room needs game=<slug> (lower-case letters, digits and hyphens)' };
  return { code, name, create, game, isPublic: query.get('public') === '1' };
}

// Counts the frames of one connection over the last second, in ten slots of
// 100 ms. The sum covers between 0.9 and 1 second, so a connection is never
// called too fast for frames that were more than a second apart.
export class FrameMeter {
  constructor() {
    this.slots = new Uint16Array(10);
    this.total = 0;
    this.last = 0;
  }

  // Counts one frame at time `now` (ms) and says whether that was too many.
  tooFast(now) {
    const slot = Math.floor(now / 100);
    if (slot !== this.last) {
      // Empty the slots that have passed since the last frame; the clock
      // going backwards empties all of them.
      const passed = slot > this.last ? Math.min(slot - this.last, 10) : 10;
      for (let i = 1; i <= passed; i++) {
        const index = (((this.last + i) % 10) + 10) % 10;
        this.total -= this.slots[index];
        this.slots[index] = 0;
      }
      this.last = slot;
    }
    this.slots[((slot % 10) + 10) % 10]++;
    this.total++;
    return this.total > MAX_FRAMES_PER_SECOND;
  }
}
