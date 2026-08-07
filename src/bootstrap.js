#!/usr/bin/env node
import path from "path";
import { chromium } from "playwright";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = path.join(root, "data", "browser-profile");
const url = process.env.STARBREAK_URL || "https://www.starbreak.com/";

console.log("[bootstrap] profile:", profile);
console.log("[bootstrap] launching headed Chromium on the virtual display");

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = context.pages()[0] || (await context.newPage());
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

console.log("[bootstrap] StarBreak is open in noVNC.");
console.log("[bootstrap] Sign in and verify the account name appears on the home screen.");
console.log("[bootstrap] Then stop this service to flush and preserve the profile.");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("[bootstrap] closing Chromium and saving the profile");
  await context.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
