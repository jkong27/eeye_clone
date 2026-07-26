/**
 * Append-only chat storage: JSONL file (+ optional Postgres later).
 */
import fs from "fs";
import path from "path";

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
