// The list of public rooms behind GET /net/rooms: one object per site.
//
// A room writes its entry when it is created public, when its listing or its
// number of players changes, and every REFRESH_MS after that; it removes the
// entry when it stops being public or empties. An entry that is not refreshed
// for EXPIRE_MS is no longer listed, so a room that was lost (its object
// restarted, its sockets gone) drops out by itself.

import { DurableObject } from 'cloudflare:workers';
import { MAX_LISTED, MAX_MEMBERS, isGame, playerName, roomCode } from './protocol.js';

// How often a public room writes its entry again, and how long an entry is
// believed without that.
export const REFRESH_MS = 2 * 60 * 1000;
export const EXPIRE_MS = 5 * 60 * 1000;

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      room TEXT PRIMARY KEY,
      game TEXT NOT NULL,
      host TEXT NOT NULL,
      players INTEGER NOT NULL,
      created INTEGER NOT NULL,
      seen INTEGER NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS rooms_created ON rooms (created)');
  }

  // Adds or refreshes a room's entry. The values come from a Room object,
  // which validated them; they are checked again because this is what a
  // public endpoint hands out.
  update({ room, game, host, players, created }) {
    const code = roomCode(room);
    const name = playerName(host);
    if (code === null || !isGame(game) || name === null) return;
    if (!Number.isInteger(players) || players < 1 || players > MAX_MEMBERS || !Number.isSafeInteger(created)) return;
    const now = Date.now();
    this.sql.exec('DELETE FROM rooms WHERE seen < ?', now - EXPIRE_MS);
    this.sql.exec(
      `INSERT INTO rooms (room, game, host, players, created, seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (room) DO UPDATE SET game = excluded.game, host = excluded.host,
         players = excluded.players, created = excluded.created, seen = excluded.seen`,
      code,
      game,
      name,
      players,
      created,
      now,
    );
  }

  remove(room) {
    this.sql.exec('DELETE FROM rooms WHERE room = ?', String(room));
  }

  // The rooms a player can join now, newest first: public, not full, and
  // refreshed lately. `game` is a slug to list one game's rooms, or null.
  list(game) {
    const fresh = Date.now() - EXPIRE_MS;
    const rows =
      game === null
        ? this.sql.exec(
            'SELECT room, game, host, players FROM rooms WHERE seen >= ? AND players < ? ORDER BY created DESC, room LIMIT ?',
            fresh,
            MAX_MEMBERS,
            MAX_LISTED,
          )
        : this.sql.exec(
            'SELECT room, game, host, players FROM rooms WHERE seen >= ? AND players < ? AND game = ? ORDER BY created DESC, room LIMIT ?',
            fresh,
            MAX_MEMBERS,
            String(game),
            MAX_LISTED,
          );
    return rows.toArray().map((row) => ({ ...row, max: MAX_MEMBERS }));
  }
}
