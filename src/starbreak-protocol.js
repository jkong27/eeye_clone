import { constants, publicEncrypt, randomInt } from "crypto";
import { EventEmitter } from "events";
import { parseProto } from "./decode.js";

const PUBLIC_KEY_BASE64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0FD8lgjzQ2tfDcNN8qYNbNN6C0vfhDk9lkCsoYm7EKhlbvKvC98D4YJ/0ihRP3uUJHtUnV8wRusFVwjSQtydvpfuk8niDMIdtyc9+eVvlBiK2hYWDnLWscoHwIOIvhQScJloS4RKRCC07xsgZ1dC7n2GVJRAi0fG+yvs4ANKp8FMq+qs8jbSz4pQkn3hqCuroNdgC5olxeHLZyW05/T9y4pbE6GmHoG8RwoPI0oCmdIRaeNCBerfZbvaNNNF/eYhLffrUwEJr35bYLMi42izxRInFb9mvbpImmzbp7VvRxneiGdRUQkRmM3V4SdaZWtA24Z3pGNroswyaYoEbiIFqwIDAQAB";

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY_BASE64.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;

function varint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}

function tag(field, wireType) {
  return varint((BigInt(field) << 3n) | BigInt(wireType));
}

function protoVarint(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function protoFixed32(field, value) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(value >>> 0);
  return Buffer.concat([tag(field, 5), data]);
}

function protoBytes(field, value = Buffer.alloc(0)) {
  const data = Buffer.from(value);
  return Buffer.concat([tag(field, 2), varint(data.length), data]);
}

export function encodeConnect({
  challenge,
  secret = null,
  timestamp = Math.floor(Date.now() / 1000),
}) {
  const fields = [protoFixed32(1, challenge)];
  if (secret === null) {
    fields.push(protoBytes(3));
  } else {
    const join = Buffer.concat([
      protoBytes(2, secret),
      protoVarint(6, 0),
      protoVarint(7, 1),
    ]);
    fields.push(protoBytes(6, join));
  }
  fields.push(
    protoVarint(32, 1),
    protoFixed32(33, timestamp),
  );
  if (secret !== null) fields.push(protoBytes(34));
  return Buffer.concat(fields);
}

export function encodeEncryptedConnect(options) {
  const plaintext = encodeConnect(options);
  const ciphertext = publicEncrypt(
    { key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    plaintext,
  );
  return encodeMessage(3, ciphertext);
}

export function encodeMessage(type, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const message = Buffer.allocUnsafe(5 + body.length);
  message[0] = type;
  message.writeUInt32BE(body.length, 1);
  body.copy(message, 5);
  return message;
}

export function encodeServerDeltaAck(elapsedMs) {
  return encodeMessage(0x0f, protoVarint(1, Math.max(1, Math.round(elapsedMs))));
}

export function encodeInputPress(input) {
  return encodeMessage(0x0e, protoVarint(2, input));
}

export function encodeInputRelease(input) {
  return encodeMessage(0x0e, protoVarint(3, input));
}

export function generateAnonymousSecret() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function first(fields, field, type) {
  return fields.get(field)?.find((entry) => entry.type === type)?.value ?? null;
}

export function parseHello(payload) {
  const challenge = first(parseProto(payload), 1, "fixed32");
  if (!Number.isInteger(challenge)) throw new Error("Hello has no challenge");
  return { challenge };
}

export function parseCluster(payload) {
  const outer = parseProto(payload);
  const clusterInfo = first(outer, 7, "bytes");
  const cluster = clusterInfo && first(parseProto(clusterInfo), 1, "bytes");
  const location = cluster && first(parseProto(cluster), 2, "bytes");
  const locationFields = location && parseProto(location);
  const hostBytes = locationFields && first(locationFields, 1, "bytes");
  const port = locationFields && first(locationFields, 3, "varint");
  if (!hostBytes || !port) throw new Error("Cluster response has no server location");
  return { host: Buffer.from(hostBytes).toString("utf8"), port };
}

export function parseJoined(payload) {
  const fields = parseProto(payload);
  const guid = first(fields, 1, "bytes");
  const accountId = first(fields, 2, "bytes");
  return {
    guid: guid ? Buffer.from(guid).toString("utf8") : null,
    accountId: accountId ? Buffer.from(accountId).toString("utf8") : null,
  };
}

export class ProtocolSocket extends EventEmitter {
  constructor(url, { origin = "https://www.starbreak.com" } = {}) {
    super();
    this.url = url;
    this.origin = origin;
    this.socket = null;
    this.pending = Buffer.alloc(0);
    this.messages = [];
  }

  async open(timeoutMs = 15_000) {
    const socket = new WebSocket(this.url, {
      headers: { Origin: this.origin },
    });
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const chunk = Buffer.from(event.data);
      this.emit("frame", chunk);
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 5) {
        const length = this.pending.readUInt32BE(1);
        if (length > 64 * 1024 * 1024) {
          this.emit("socket-error", new Error(`invalid protocol length: ${length}`));
          return;
        }
        if (this.pending.length < 5 + length) break;
        const type = this.pending[0];
        const payload = this.pending.subarray(5, 5 + length);
        this.pending = this.pending.subarray(5 + length);
        const message = { type, payload };
        this.messages.push(message);
        if (this.messages.length > 1_000) this.messages.shift();
        this.emit("message", message);
      }
    });
    socket.addEventListener("close", (event) => {
      this.emit("close", { code: event.code, reason: event.reason });
    });
    socket.addEventListener("error", () => {
      this.emit("socket-error", new Error(`websocket error: ${this.url}`));
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`open timeout: ${this.url}`)), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`websocket error: ${this.url}`));
      }, { once: true });
    });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(message);
    return true;
  }

  waitFor(type, timeoutMs = 15_000, predicate = () => true) {
    const queuedIndex = this.messages.findIndex(
      (message) => message.type === type && predicate(message.payload),
    );
    if (queuedIndex !== -1) {
      const [message] = this.messages.splice(queuedIndex, 1);
      return Promise.resolve(message.payload);
    }
    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message.type !== type || !predicate(message.payload)) return;
        const messageIndex = this.messages.indexOf(message);
        if (messageIndex !== -1) this.messages.splice(messageIndex, 1);
        cleanup();
        resolve(message.payload);
      };
      const onClose = ({ code }) => {
        cleanup();
        reject(new Error(`socket closed while waiting for type ${type}: ${code}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("close", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for message type ${type}`));
      }, timeoutMs);
      this.on("message", onMessage);
      this.on("close", onClose);
    });
  }

  close() {
    this.socket?.close();
  }
}
