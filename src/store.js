import pg from "pg";

const { Pool } = pg;

/** Make chat safe for one-line logs and UI while preserving raw separately. */
export function normalizeChatMessage(message) {
  return String(message ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

export async function createPostgresStore(connectionString = null) {
  // With no URL, node-postgres reads PGHOST, PGPORT, PGDATABASE,
  // PGUSER, and PGPASSWORD from the environment.
  const pool = new Pool(connectionString ? { connectionString } : {});
  pool.on("error", (error) => {
    // Idle clients can be terminated during database maintenance/restarts.
    // Keeping this listener prevents node-postgres from treating that as an
    // uncaught process-level error; the pool reconnects on the next query.
    console.error("[postgres] idle connection error:", error.message);
  });
  await pool.query("SELECT 1");
  await pool.query(POSTGRES_SCHEMA);
  return {
    path: "postgres",
    async write(event) {
      const message = normalizeChatMessage(event.message);
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
            message, event.url || null, event.flag ?? null, event],
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
