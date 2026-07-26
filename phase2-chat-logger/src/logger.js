#!/usr/bin/env node
/**
 * Phase 2 — always-on StarBreak lobby chat logger (web client).
 *
 * First run is interactive: log in + enter Eschaton, then press Enter in this
 * terminal. Cookies are saved so later runs can reuse the session.
 *
 * Usage:
 *   node src/logger.js
 *   node src/logger.js --headed
 *   node src/logger.js --profile ./data/profile --out ./data/chat.jsonl
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { decodeFrame } from "./decode.js";
import { createJsonlStore, POSTGRES_SCHEMA } from "./store.js";
import { WS_HOOK_SOURCE } from "./ws-hook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = {
    headed: true,
    profile: path.join(ROOT, "data", "browser-profile"),
    out: path.join(ROOT, "data", "chat.jsonl"),
    url: "https://www.starbreak.com/",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") args.headed = true;
    else if (a === "--headless") args.headed = false;
    else if (a === "--profile") args.profile = path.resolve(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--url") args.url = argv[++i];
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
  if (args.help) {
    console.log(`StarBreak chat logger

  node src/logger.js [--headed|--headless] [--profile DIR] [--out FILE]

Logs player chat and SYSTEM announcements to JSONL.
SYSTEM is a special player (player_id = "SYSTEM").

Postgres schema (optional) is printed with --schema.`);
    process.exit(0);
  }
  if (process.argv.includes("--schema")) {
    console.log(POSTGRES_SCHEMA);
    process.exit(0);
  }

  fs.mkdirSync(args.profile, { recursive: true });
  const store = createJsonlStore(args.out);
  const seen = new Set();
  let decoded = 0;

  console.log("[eeye] profile:", args.profile);
  console.log("[eeye] writing:", store.path);
  console.log("[eeye] launching Chromium…");

  const context = await chromium.launchPersistentContext(args.profile, {
    headless: !args.headed,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  await context.exposeBinding("__eeyeOnWsFrame", async (_source, frame) => {
    try {
      const buf = Buffer.from(frame.b64, "base64");
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
        console.log(`[chat] <${who}> ${ev.message}`);
      }
    } catch (err) {
      console.error("[eeye] frame error:", err.message);
    }
  });

  await context.addInitScript({ content: WS_HOOK_SOURCE });

  const page = context.pages()[0] || (await context.newPage());

  await page.goto(args.url, { waitUntil: "domcontentloaded" });
  await page.exposeFunction("__eeyeOnWsSend", async (packet) => {
    await fs.promises.appendFile("ws-out.jsonl", JSON.stringify(packet) + "\n");
  });

  console.log(`
[eeye] Browser open.
  1. Log in if needed
  2. Enter Eschaton (lobby) on your target server
  3. Come back here and press Enter to mark "online"
`);
  await ask("Press Enter when the bot is parked in Eschaton… ");
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

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
