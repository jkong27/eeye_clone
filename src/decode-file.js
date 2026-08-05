#!/usr/bin/env node
/**
 * Decode a Phase 1 capture JSONL into chat events.
 * Usage: node src/decode-file.js <capture.jsonl> [out.jsonl]
 */
import fs from "fs";
import path from "path";
import { decodeCaptureFrame, SYSTEM_PLAYER } from "./decode.js";

const inPath = process.argv[2];
if (!inPath) {
  console.error("Usage: node src/decode-file.js <capture.jsonl> [out.jsonl]");
  process.exit(1);
}

const outPath =
  process.argv[3] ||
  path.join(path.dirname(path.resolve(inPath)), "decoded-chat.jsonl");

const lines = fs.readFileSync(inPath, "utf8").split(/\r?\n/).filter(Boolean);
const events = [];

for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  for (const ev of decodeCaptureFrame(obj)) events.push(ev);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""),
  "utf8"
);

console.log(`SYSTEM player id: ${SYSTEM_PLAYER.playerId}`);
console.log(`Decoded ${events.length} chat event(s) → ${outPath}`);
for (const e of events) {
  const who = e.kind === "system" ? "SYSTEM" : `${e.player} (${e.playerId})`;
  console.log(`  [${e.t || "?"}] <${who}> ${e.message}`);
}
