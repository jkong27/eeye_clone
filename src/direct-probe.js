#!/usr/bin/env node
import { decodeFrame } from "./decode.js";
import {
  encodeEncryptedConnect,
  encodeMessage,
  encodeServerDeltaAck,
  generateAnonymousSecret,
  parseCluster,
  parseHello,
  parseJoined,
  ProtocolSocket,
} from "./starbreak-protocol.js";

const controlUrl = process.env.STARBREAK_CONTROL_URL || "wss://prod.sbmach.com:443/";
const durationSeconds = Number(process.env.DIRECT_PROBE_SECONDS || 60);
const secret = process.env.STARBREAK_ANONYMOUS_SECRET || generateAnonymousSecret();
const startedAt = Date.now();
const log = (message) => {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[direct +${elapsed}s] ${message}`);
};

log("connecting to control socket");
const control = new ProtocolSocket(controlUrl);
await control.open();
const controlHello = parseHello(await control.waitFor(1));
control.send(encodeEncryptedConnect({ challenge: controlHello.challenge }));
const cluster = parseCluster(await control.waitFor(4));
log(`assigned game shard: ${cluster.host}:${cluster.port}`);
control.close();

const gameUrl = `wss://${cluster.host}:${cluster.port}/`;
const game = new ProtocolSocket(gameUrl);
let decoded = 0;
let deltaPackets = 0;
let resolveClosed;
const gameClosed = new Promise((resolve) => {
  resolveClosed = resolve;
});
game.on("frame", (frame) => {
  for (const event of decodeFrame(frame, { t: new Date().toISOString(), url: gameUrl })) {
    decoded++;
    console.log(`[direct-chat] <${event.player}> ${event.message}`);
  }
});
game.on("message", ({ type }) => {
  if (type !== 0x25 && type !== 0x0c) return;
  deltaPackets++;
  game.send(encodeMessage(0x0d));
});
game.on("close", ({ code, reason }) => {
  log(`game socket closed: ${code}${reason ? ` ${reason}` : ""}`);
  resolveClosed({ code, reason });
});
game.on("socket-error", (error) => console.error("[direct]", error.message));

await game.open();
const gameHello = parseHello(await game.waitFor(1));
game.send(encodeEncryptedConnect({ challenge: gameHello.challenge, secret }));
const joined = parseJoined(await game.waitFor(8));
log(`joined anonymously: ${joined.accountId || "unknown account"}`);

game.send(encodeMessage(0x16));
const world = await game.waitFor(0x0a, 20_000);
if (world.includes(Buffer.from("tutorial", "ascii"))) {
  log("tutorial detected; waiting for it to initialize");
  await new Promise((resolve) => setTimeout(resolve, 5_250));
  log("sending tutorial skip command");
  game.send(encodeMessage(0x16));
  await game.waitFor(0x10, 20_000);
  log("Eschaton world received");
}

game.send(encodeMessage(0x0b));
let lastStateAt = Date.now();
const stateInterval = setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastStateAt;
  if (elapsed < 10) return;
  const chunks = Math.ceil(elapsed / 40);
  const step = Math.floor(elapsed / chunks);
  for (let index = 0; index < chunks; index++) {
    game.send(encodeServerDeltaAck(step));
  }
  lastStateAt = now;
}, 20);

log(`observing with minimal client-state heartbeat for ${durationSeconds}s`);
let durationTimer;
const outcome = await Promise.race([
  new Promise((resolve) => {
    durationTimer = setTimeout(() => resolve("duration"), durationSeconds * 1000);
  }),
  gameClosed.then(() => "closed"),
]);
clearTimeout(durationTimer);
clearInterval(stateInterval);
log(
  `probe ${outcome === "duration" ? "complete" : "ended by disconnect"}: ` +
    `${decoded} chat events, ${deltaPackets} delta packets acknowledged`,
);
game.close();
