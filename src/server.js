#!/usr/bin/env node
import http from "http";
import fs from "fs/promises";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const { Pool } = pg;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {},
);

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

async function apiPlayers(url, res) {
  const query = (url.searchParams.get("q") || "").trim();
  const limit = positiveInt(url.searchParams.get("limit"), 20, 50);
  const result = await pool.query(
    `SELECT p.player_id, p.name, p.last_seen, count(m.id)::int AS message_count
       FROM players p
       JOIN chat_messages m ON m.player_id = p.player_id
      WHERE p.is_system = FALSE
        AND p.player_id <> 'SYSTEM'
        AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.player_id = $1)
      GROUP BY p.player_id, p.name, p.last_seen
      ORDER BY CASE WHEN lower(p.name) = lower($1) THEN 0 ELSE 1 END,
               p.last_seen DESC, p.name
      LIMIT $2`,
    [query, limit],
  );
  sendJson(res, 200, { players: result.rows });
}

async function apiRecentMessages(res) {
  const result = await pool.query(
    `SELECT m.id, m.received_at, m.player_id, p.name AS player, m.kind,
            m.message, m.server_url, m.flag
       FROM chat_messages m
       JOIN players p ON p.player_id = m.player_id
      ORDER BY m.id DESC
      LIMIT 100`,
  );
  sendJson(res, 200, { messages: result.rows });
}

async function apiMessages(url, res) {
  const playerId = (url.searchParams.get("player_id") || "").trim();
  if (!playerId || playerId === "SYSTEM") {
    return sendJson(res, 400, { error: "A non-SYSTEM player_id is required." });
  }
  const limit = positiveInt(url.searchParams.get("limit"), 100, 250);
  const before = url.searchParams.get("before");
  const beforeId = before ? Number.parseInt(before, 10) : null;
  if (before && (!Number.isSafeInteger(beforeId) || beforeId <= 0)) {
    return sendJson(res, 400, { error: "Invalid pagination cursor." });
  }

  const result = await pool.query(
    `SELECT m.id, m.received_at, m.player_id, p.name AS player, m.message,
            m.server_url, m.flag
       FROM chat_messages m
       JOIN players p ON p.player_id = m.player_id
      WHERE m.player_id = $1
        AND m.player_id <> 'SYSTEM'
        AND ($2::bigint IS NULL OR m.id < $2)
      ORDER BY m.id DESC
      LIMIT $3`,
    [playerId, beforeId, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const messages = result.rows.slice(0, limit);
  sendJson(res, 200, {
    messages,
    next_cursor: hasMore ? messages.at(-1).id : null,
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self'; script-src 'self'",
  );

  if (req.method !== "GET")
    return sendJson(res, 405, { error: "Method not allowed." });
  if (url.pathname === "/api/health") {
    await pool.query("SELECT 1");
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/api/recent-messages")
    return apiRecentMessages(res);
  if (url.pathname === "/api/players") return apiPlayers(url, res);
  if (url.pathname === "/api/messages") return apiMessages(url, res);

  const asset = assets.get(url.pathname);
  if (!asset) return sendJson(res, 404, { error: "Not found." });
  const [file, contentType] = asset;
  const body = await fs.readFile(path.join(publicDir, file));
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("[ui] request failed:", error);
    if (!res.headersSent)
      sendJson(res, 500, { error: "Internal server error." });
    else res.end();
  });
});

server.listen(port, host, () => {
  console.log(`[ui] listening on http://${host}:${port}`);
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
