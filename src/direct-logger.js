#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { decodeFrame } from "./decode.js";
import { connectToEschaton } from "./direct-client.js";
import { generateAnonymousSecret } from "./starbreak-protocol.js";
import { createPostgresStore, normalizeChatMessage } from "./store.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const healthPath = path.join(root, "data", "collector-health.json");
const keepaliveMinutes = Number(process.env.KEEPALIVE_MINUTES || 12);
const staleSeconds = Number(process.env.STALE_SECONDS || 90);
const databaseUrl = process.env.DATABASE_URL || null;
const postgresEnabled = databaseUrl || process.env.PGDATABASE;

if (!postgresEnabled) {
  throw new Error("PostgreSQL configuration is required (DATABASE_URL or PGDATABASE).");
}
if (!(keepaliveMinutes > 0) || !(staleSeconds > 0)) {
  throw new Error("KEEPALIVE_MINUTES and STALE_SECONDS must be positive numbers.");
}

fs.mkdirSync(path.dirname(healthPath), { recursive: true });
const store = await createPostgresStore(databaseUrl);
const secret = process.env.STARBREAK_ANONYMOUS_SECRET || generateAnonymousSecret();
const seen = new Set();
let session = null;
let stopping = false;
let decoded = 0;
let writeChain = Promise.resolve();
let lastHealthWrite = 0;
let shutdownPromise = null;
let cancelReconnectWait = null;

function writeHealth(status, detail = null, gameSocket = session?.gameUrl || null) {
  const health = {
    status,
    detail,
    mode: "direct-websocket",
    game_socket: gameSocket,
    updated_at: new Date().toISOString(),
  };
  fs.promises.writeFile(healthPath, JSON.stringify(health) + "\n").catch((error) => {
    console.error("[eeye] health write failed:", error.message);
  });
}

function queueFrame(frame, gameUrl) {
  const receivedAt = new Date().toISOString();
  const events = decodeFrame(frame, { t: receivedAt, url: gameUrl });
  for (const event of events) {
    const key = `${event.t}|${event.playerId}|${event.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 5_000) seen.delete(seen.values().next().value);
    writeChain = writeChain
      .then(async () => {
        await store.write(event);
        decoded++;
        const who =
          event.kind === "system" ? "SYSTEM" : `${event.player} (${event.playerId})`;
        console.log(`[chat] <${who}> ${normalizeChatMessage(event.message)}`);
      })
      .catch((error) => console.error("[eeye] database write failed:", error.message));
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancelReconnectWait = null;
      resolve();
    }, ms);
    cancelReconnectWait = () => {
      clearTimeout(timer);
      cancelReconnectWait = null;
      resolve();
    };
  });
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    console.log(`\n[eeye] stopping — ${decoded} messages written`);
    writeHealth("stopping");
    cancelReconnectWait?.();
    session?.stop();
    await writeChain;
    await store.close();
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log("[eeye] collector mode: direct WebSocket (no browser)");
console.log("[eeye] identity: ephemeral anonymous session");
console.log("[eeye] writing: postgres");

let failures = 0;
while (!stopping) {
  try {
    writeHealth(failures ? "reconnecting" : "connecting");
    console.log(`[eeye] ${failures ? "reconnecting" : "connecting"} to StarBreak`);
    session = await connectToEschaton({
      secret,
      keepaliveMinutes,
      staleSeconds,
      onFrame: queueFrame,
      onActivity: ({ gameUrl }) => {
        if (Date.now() - lastHealthWrite < 5_000) return;
        lastHealthWrite = Date.now();
        writeHealth("connected", null, gameUrl);
      },
      onLog: (message) => console.log(`[eeye] ${message}`),
    });
    failures = 0;
    writeHealth("connected", null, session.gameUrl);
    console.log(
      `[eeye] Eschaton connected: ${session.gameUrl} ` +
        `(anonymous account ${session.joined.accountId || "unknown"})`,
    );
    console.log("[eeye] logging chat (Ctrl+C to stop). SYSTEM = special player.\n");
    const { code, reason } = await session.closed;
    session = null;
    if (stopping) break;
    throw new Error(`game socket closed (${code}${reason ? `: ${reason}` : ""})`);
  } catch (error) {
    if (stopping) break;
    session?.stop();
    session = null;
    failures++;
    const delaySeconds = Math.min(60, 3 * 2 ** Math.min(failures - 1, 5));
    writeHealth("reconnecting", error.message);
    console.error(`[eeye] connection failed: ${error.message}`);
    console.log(`[eeye] reconnect attempt ${failures} in ${delaySeconds}s`);
    await wait(delaySeconds * 1_000);
  }
}

await shutdown();
writeHealth("stopped");
