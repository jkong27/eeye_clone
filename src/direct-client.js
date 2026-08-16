import {
  encodeEncryptedConnect,
  encodeInputPress,
  encodeInputRelease,
  encodeMessage,
  encodeServerDeltaAck,
  parseCluster,
  parseHello,
  parseJoined,
  ProtocolSocket,
} from "./starbreak-protocol.js";

const CONTROL_URL = "wss://prod.sbmach.com:443/";
const TUTORIAL_MARKER = Buffer.from("tutorial", "ascii");
const LOBBY_MARKER = Buffer.from("lobby", "ascii");
const INPUT_H = 256;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function splitServerTimeDelta(elapsedMs) {
  const elapsed = Math.max(1, Math.floor(elapsedMs));
  const chunks = Math.ceil(elapsed / 40);
  const step = Math.floor(elapsed / chunks);
  return Array.from({ length: chunks }, () => step);
}

export async function connectToEschaton({
  secret,
  controlUrl = CONTROL_URL,
  keepaliveMinutes = 12,
  staleSeconds = 90,
  onFrame = () => {},
  onActivity = () => {},
  onLog = () => {},
}) {
  let stopped = false;
  let stateInterval = null;
  let keepaliveInterval = null;
  let watchdogInterval = null;
  let lastActivity = Date.now();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const control = new ProtocolSocket(controlUrl);
  control.on("socket-error", (error) => onLog(`control socket error: ${error.message}`));
  let cluster;
  try {
    await control.open();
    const controlHello = parseHello(await control.waitFor(1));
    control.send(encodeEncryptedConnect({ challenge: controlHello.challenge }));
    cluster = parseCluster(await control.waitFor(4));
  } finally {
    control.close();
  }

  const gameUrl = `wss://${cluster.host}:${cluster.port}/`;
  const game = new ProtocolSocket(gameUrl);
  const touch = () => {
    lastActivity = Date.now();
    onActivity({ gameUrl, at: lastActivity });
  };

  game.on("frame", (frame) => {
    touch();
    onFrame(frame, gameUrl);
  });
  game.on("message", ({ type }) => {
    if (type === 0x25 || type === 0x0c) game.send(encodeMessage(0x0d));
  });
  game.on("socket-error", (error) => onLog(`game socket error: ${error.message}`));
  game.on("close", ({ code, reason }) => {
    cleanup();
    resolveClosed({ code, reason });
  });

  const cleanup = () => {
    clearInterval(stateInterval);
    clearInterval(keepaliveInterval);
    clearInterval(watchdogInterval);
    stateInterval = null;
    keepaliveInterval = null;
    watchdogInterval = null;
  };

  try {
    await game.open();
    const gameHello = parseHello(await game.waitFor(1));
    game.send(encodeEncryptedConnect({ challenge: gameHello.challenge, secret }));
    const joined = parseJoined(await game.waitFor(8));

    // The browser starts its client clock as soon as the game session is joined.
    // The server ignores tutorial input if this state stream has not started yet.
    let lastStateAt = Date.now();
    stateInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastStateAt;
      if (elapsed < 10) return;
      for (const step of splitServerTimeDelta(elapsed)) {
        game.send(encodeServerDeltaAck(step));
      }
      lastStateAt = now;
    }, 20);

    game.send(encodeMessage(0x16));
    const world = await game.waitFor(0x0a, 20_000);
    game.send(encodeMessage(0x0b));
    if (world.includes(TUTORIAL_MARKER)) {
      onLog("tutorial detected; waiting 5.25s before sending H");
      await delay(5_250);
      if (stopped) throw new Error("connection stopped during tutorial");
      game.send(encodeInputPress(INPUT_H));
      await game.waitFor(0x15, 20_000, (payload) => payload.includes(LOBBY_MARKER));
      onLog("tutorial exit accepted; loading Eschaton");
      game.send(encodeMessage(0x16));
      await game.waitFor(0x0a, 20_000, (payload) => payload.includes(LOBBY_MARKER));
      game.send(encodeMessage(0x0b));
      onLog("tutorial skipped; Eschaton lobby received");
    }

    const sendMovementKeepalive = async () => {
      const packets = [
        encodeInputPress(1),
        encodeInputRelease(1),
        encodeInputPress(2),
        encodeInputRelease(2),
      ];
      for (const packet of packets) {
        if (stopped) return;
        game.send(packet);
        await delay(100);
      }
      onLog("activity keepalive sent");
    };
    keepaliveInterval = setInterval(
      () => void sendMovementKeepalive().catch((error) => onLog(`keepalive failed: ${error.message}`)),
      keepaliveMinutes * 60_000,
    );
    keepaliveInterval.unref();

    watchdogInterval = setInterval(() => {
      if (Date.now() - lastActivity <= staleSeconds * 1000) return;
      onLog(`no game traffic for ${staleSeconds}s; closing stale socket`);
      game.close();
    }, 15_000);
    watchdogInterval.unref();

    touch();
    return {
      gameUrl,
      joined,
      closed,
      stop() {
        stopped = true;
        cleanup();
        game.close();
      },
    };
  } catch (error) {
    stopped = true;
    cleanup();
    game.close();
    throw error;
  }
}
