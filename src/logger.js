#!/usr/bin/env node
/**
 * Phase 2 — always-on StarBreak lobby chat logger (web client).
 *
 * A persistent anonymous browser profile is reused between runs. Automatic
 * entry clicks Play and skips the tutorial when it is detected.
 *
 * Usage:
 *   node src/logger.js
 *   node src/logger.js --headed
 *   node src/logger.js --profile ./data/profile
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { decodeFrame, discoverPlayerChat } from "./decode.js";
import {
  createPostgresStore,
  normalizeChatMessage,
  POSTGRES_SCHEMA,
} from "./store.js";
import { WS_HOOK_SOURCE } from "./ws-hook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TUTORIAL_MARKER = Buffer.from("tutorial", "ascii");

function parseArgs(argv) {
  const args = {
    headed: true,
    profile: path.join(ROOT, "data", "browser-profile"),
    url: "https://www.starbreak.com/",
    databaseUrl: process.env.DATABASE_URL || null,
    keepaliveMinutes: 12,
    staleSeconds: 90,
    playDelaySeconds: 2,
    manual: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") args.headed = true;
    else if (a === "--headless") args.headed = false;
    else if (a === "--profile") args.profile = path.resolve(argv[++i]);
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--database-url") args.databaseUrl = argv[++i];
    else if (a === "--keepalive-minutes") args.keepaliveMinutes = Number(argv[++i]);
    else if (a === "--stale-seconds") args.staleSeconds = Number(argv[++i]);
    else if (a === "--play-delay-seconds") args.playDelaySeconds = Number(argv[++i]);
    else if (a === "--manual") args.manual = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (
    !(args.keepaliveMinutes > 0) ||
    !(args.staleSeconds > 0) ||
    !(args.playDelaySeconds >= 0)
  ) {
    throw new Error(
      "keepalive-minutes and stale-seconds must be positive; play-delay-seconds cannot be negative",
    );
  }
  if (args.help) {
    console.log(`StarBreak chat logger

  node src/logger.js [--headed|--headless] [--profile DIR]
                     [--database-url URL] [--keepalive-minutes N]
                     [--stale-seconds N] [--play-delay-seconds N] [--manual]

Logs player chat and SYSTEM announcements to PostgreSQL.
SYSTEM is a special player (player_id = "SYSTEM").

Postgres schema (optional) is printed with --schema.`);
    process.exit(0);
  }
  if (process.argv.includes("--schema")) {
    console.log(POSTGRES_SCHEMA);
    process.exit(0);
  }

  fs.mkdirSync(args.profile, { recursive: true });
  const postgresEnabled = args.databaseUrl || process.env.PGDATABASE;
  if (!postgresEnabled) {
    throw new Error("PostgreSQL configuration is required (DATABASE_URL or PGDATABASE).");
  }
  const store = await createPostgresStore(args.databaseUrl);
  const seen = new Set();
  const healthPath = path.join(ROOT, "data", "collector-health.json");
  let decoded = 0;
  let lastWsActivity = Date.now();
  let reconnecting = false;
  let monitoringArmed = false;
  let activeGameSocket = null;
  let diagnosticFrames = 0;
  let tutorialDetectionDeadline = 0;
  let tutorialSkipScheduled = false;
  let tutorialGeneration = 0;

  const isGameSocket = (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host.endsWith(".sbmach.com") && host !== "prod.sbmach.com";
    } catch {
      return false;
    }
  };

  const writeHealth = (status, detail = null) => {
    const health = {
      status,
      detail,
      game_socket: activeGameSocket,
      updated_at: new Date().toISOString(),
    };
    fs.promises.writeFile(healthPath, JSON.stringify(health) + "\n").catch((error) => {
      console.error("[eeye] health write failed:", error.message);
    });
  };

  console.log("[eeye] profile:", args.profile);
  console.log("[eeye] writing: postgres");
  console.log("[eeye] launching Chromium…");

  const context = await chromium.launchPersistentContext(args.profile, {
    headless: !args.headed,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  await context.exposeBinding("__eeyeOnWsFrame", async (_source, frame) => {
    try {
      const buf = Buffer.from(frame.b64, "base64");
      if (
        !tutorialSkipScheduled &&
        Date.now() < tutorialDetectionDeadline &&
        frame.direction === "in" &&
        isGameSocket(frame.url) &&
        buf.includes(TUTORIAL_MARKER)
      ) {
        tutorialSkipScheduled = true;
        const generation = tutorialGeneration;
        console.log("[eeye] tutorial detected; pressing H to skip in 6s");
        setTimeout(async () => {
          if (generation !== tutorialGeneration) return;
          try {
            const activePage = context.pages()[0];
            if (!activePage || activePage.isClosed()) return;
            await activePage.bringToFront();
            await activePage.keyboard.down("h");
            await activePage.waitForTimeout(150);
            await activePage.keyboard.up("h");
            console.log("[eeye] tutorial skip sent");
          } catch (error) {
            console.error("[eeye] tutorial skip failed:", error.message);
          }
        }, 6000);
      }
      const events = decodeFrame(buf, {
        t: frame.t,
        direction: frame.direction,
        url: frame.url,
      });
      for (const ev of events) {
        const key = `${ev.t}|${ev.playerId}|${ev.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 5000) {
          const first = seen.values().next().value;
          seen.delete(first);
        }
        await store.write(ev);
        decoded++;
        const who =
          ev.kind === "system" ? "SYSTEM" : `${ev.player} (${ev.playerId})`;
        console.log(`[chat] <${who}> ${normalizeChatMessage(ev.message)}`);
      }
    } catch (err) {
      console.error("[eeye] frame error:", err.message);
    }
  });

  await context.exposeBinding("__eeyeOnWsDiagnostic", (_source, frame) => {
    if (process.env.DEBUG_CHAT !== "1" || diagnosticFrames >= 100) return;
    const bytes = Buffer.from(frame.b64, "base64");
    const candidates = discoverPlayerChat(bytes);
    for (const candidate of candidates) {
      diagnosticFrames++;
      console.log("[chat-diagnostic]", JSON.stringify(candidate));
    }
    if (!candidates.length) {
      const strings = bytes
        .toString("latin1")
        .split(/[^\x20-\x7e]+/)
        .filter((value) => value.length >= 4 && value.includes(" "))
        .slice(0, 8);
      if (strings.length) {
        diagnosticFrames++;
        console.log(
          "[chat-diagnostic]",
          JSON.stringify({
            frameLen: bytes.length,
            firstTag: bytes.subarray(0, 4).toString("hex"),
            strings,
          }),
        );
      }
    }
  });

  await context.exposeBinding("__eeyeOnWsActivity", (_source, activity) => {
    if (activity.url === activeGameSocket) {
      lastWsActivity = Date.now();
      writeHealth("connected");
    }
  });

  await context.addInitScript({
    content: `window.__eeyeDebugChat = ${process.env.DEBUG_CHAT === "1"};`,
  });
  await context.addInitScript({ content: WS_HOOK_SOURCE });

  const page = context.pages()[0] || (await context.newPage());

  const waitForGameSocket = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (activeGameSocket) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  const enterGame = async () => {
    activeGameSocket = null;
    tutorialGeneration++;
    tutorialSkipScheduled = false;
    tutorialDetectionDeadline = Date.now() + 90_000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const canvas = page.locator("canvas").first();
      await canvas.waitFor({ state: "visible", timeout: 30000 });
      const box = await canvas.boundingBox();
      if (!box) throw new Error("StarBreak canvas has no visible bounds");

      if (args.playDelaySeconds > 0) {
        console.log(`[eeye] waiting ${args.playDelaySeconds}s for menu stabilization`);
        await page.waitForTimeout(args.playDelaySeconds * 1000);
      }
      // PLAY is at approximately (25%, 53%) of StarBreak's fixed canvas.
      await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.527);
      console.log(`[eeye] Play clicked (attempt ${attempt}/3); waiting for game shard`);
      if (await waitForGameSocket(30000)) {
        await page.waitForTimeout(3000);
        console.log(`[eeye] game shard ready: ${activeGameSocket}`);
        return;
      }
      console.warn("[eeye] matchmaking did not yield a game shard; retrying");
    }
    throw new Error(
      "Could not enter the game automatically. Run with --manual to inspect the game state.",
    );
  };

  const reconnect = async (reason) => {
    if (reconnecting || page.isClosed()) return;
    reconnecting = true;
    console.warn(`[eeye] reconnecting: ${reason}`);
    let attempt = 0;
    try {
      while (!page.isClosed()) {
        attempt++;
        const delayMs = Math.min(3000 * 2 ** (attempt - 1), 30000);
        console.log(`[eeye] reconnect attempt ${attempt} in ${delayMs / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          activeGameSocket = null;
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
          await enterGame();
          lastWsActivity = Date.now();
          console.log("[eeye] reconnection complete");
          return;
        } catch (error) {
          console.error(`[eeye] reconnect attempt ${attempt} failed:`, error.message);
        }
      }
    } finally {
      reconnecting = false;
    }
  };

  await context.exposeBinding("__eeyeOnWsStatus", async (_source, status) => {
    const gameSocket = isGameSocket(status.url);
    console.log(
      `[eeye] websocket ${status.type}: ${status.url}${gameSocket ? " [game]" : " [control]"}`,
    );
    if (status.type === "open" && gameSocket) {
      activeGameSocket = status.url;
      tutorialDetectionDeadline = Date.now() + 30_000;
      lastWsActivity = Date.now();
      writeHealth("connected");
    }
    const activeGameSocketFailed =
      monitoringArmed &&
      gameSocket &&
      status.url === activeGameSocket &&
      (status.type === "close" || status.type === "error");
    if (activeGameSocketFailed) {
      writeHealth("reconnecting", `websocket ${status.type}`);
      void reconnect(`websocket ${status.type}${status.code ? ` (${status.code})` : ""}`);
    }
  });

  await page.goto(args.url, { waitUntil: "domcontentloaded" });

  if (args.manual) {
    console.log(`
[eeye] Manual setup enabled.
  1. Enter Eschaton (lobby) in the browser
  2. Come back here and press Enter to mark "online"
`);
    await ask("Press Enter when the bot is parked in Eschaton… ");
  } else {
    console.log("[eeye] automatically entering Eschaton");
    await enterGame();
  }
  monitoringArmed = true;
  lastWsActivity = Date.now();
  if (!activeGameSocket) {
    console.warn("[eeye] no game shard websocket detected yet; watchdog is armed");
  }
  console.log(
    "[eeye] logging chat (Ctrl+C to stop). SYSTEM = special player.\n",
  );

  const shutdown = async () => {
    console.log(`\n[eeye] stopping — ${decoded} messages written`);
    await store.close();
    await context.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const keepalive = setInterval(async () => {
    if (page.isClosed() || reconnecting) return;
    try {
      await page.keyboard.down("ArrowLeft");
      await page.waitForTimeout(100);
      await page.keyboard.up("ArrowLeft");
      await page.keyboard.down("ArrowRight");
      await page.waitForTimeout(100);
      await page.keyboard.up("ArrowRight");
      console.log("[eeye] activity keepalive sent");
    } catch (error) {
      console.error("[eeye] keepalive failed:", error.message);
      void reconnect("keepalive failure");
    }
  }, args.keepaliveMinutes * 60_000);
  keepalive.unref();

  const watchdog = setInterval(() => {
    if (
      monitoringArmed &&
      activeGameSocket &&
      Date.now() - lastWsActivity > args.staleSeconds * 1000
    ) {
      void reconnect(`no websocket traffic for ${args.staleSeconds}s`);
    }
  }, 15_000);
  watchdog.unref();

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
