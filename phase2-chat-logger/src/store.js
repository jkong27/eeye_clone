/**
 * Append-only chat storage: JSONL file (+ optional Postgres later).
 */
import fs from "fs";
import path from "path";
import pg from "pg";

const { Pool } = pg;

export function createJsonlStore(filePath) {
  const abs = path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const stream = fs.createWriteStream(abs, { flags: "a" });
  let count = 0;

  return {
    path: abs,
    async write(event) {
      const row = {
        t: event.t || new Date().toISOString(),
        player: event.player,
        player_id: event.playerId,
        kind: event.kind,
        message: event.message,
        server_url: event.url || null,
        flag: event.flag ?? null,
      };
      stream.write(JSON.stringify(row) + "\n");
      count++;
      return row;
    },
    async close() {
      await new Promise((resolve) => stream.end(resolve));
    },
    get count() {
      return count;
    },
  };
}

export async function createPostgresStore(connectionString) {
  const pool = new Pool({ connectionString });
  await pool.query("SELECT 1");
  await pool.query(POSTGRES_SCHEMA);
  return {
    path: "postgres",
    async write(event) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO players (player_id, name, is_system, last_seen)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (player_id) DO UPDATE
             SET name = EXCLUDED.name, last_seen = now()`,
          [event.playerId, event.player, event.kind === "system"],
        );
        const result = await client.query(
          `INSERT INTO chat_messages
             (received_at, player_id, kind, message, server_url, flag, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [event.t || new Date().toISOString(), event.playerId, event.kind,
            event.message, event.url || null, event.flag ?? null, event],
        );
        await client.query("COMMIT");
        return { id: result.rows[0].id };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

export function combineStores(stores) {
  const active = stores.filter(Boolean);
  return {
    path: active.map((store) => store.path).join(" + "),
    async write(event) {
      return Promise.all(active.map((store) => store.write(event)));
    },
    async close() {
      await Promise.allSettled(active.map((store) => store.close()));
    },
  };
}

/** Suggested Postgres schema (run manually when ready). */
export const POSTGRES_SCHEMA = `
-- SYSTEM is a first-class player row (player_id = 'SYSTEM').
CREATE TABLE IF NOT EXISTS players (
  player_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO players (player_id, name, is_system)
VALUES ('SYSTEM', 'SYSTEM', TRUE)
ON CONFLICT (player_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(player_id),
  kind        TEXT NOT NULL CHECK (kind IN ('player', 'system')),
  message     TEXT NOT NULL,
  server_url  TEXT,
  flag        INTEGER,
  raw         JSONB
);

CREATE INDEX IF NOT EXISTS chat_messages_received_at_idx
  ON chat_messages (received_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_player_id_idx
  ON chat_messages (player_id, received_at DESC);
`;
