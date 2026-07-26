/**
 * StarBreak WebSocket chat decoder.
 *
 * Wire format (inside binary WS frames):
 *   u32le type = 0x14
 *   u8    payload_len
 *   protobuf payload:
 *     field 1 (string) = player name   — player chat only
 *     field 2 (string) = player id     — player chat only
 *     field 4 (string) = message text
 *     field 6 (varint) = optional flag — system announcements
 *
 * Messages without a player name are attributed to SYSTEM.
 */

export const SYSTEM_PLAYER = {
  name: "SYSTEM",
  playerId: "SYSTEM",
};

const CHAT_TYPE = 0x14;

function readVarint(buf, i) {
  let x = 0;
  let s = 0;
  while (i < buf.length) {
    const b = buf[i++];
    x |= (b & 0x7f) << s;
    if (!(b & 0x80)) return [x >>> 0, i];
    s += 7;
    if (s > 35) break;
  }
  return null;
}

/** Parse a flat protobuf message into { fieldNum: [{ type, value }] }. */
export function parseProto(buf) {
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag) break;
    let [key, ni] = tag;
    i = ni;
    const fn = key >>> 3;
    const wt = key & 7;
    let entry;
    if (wt === 0) {
      const v = readVarint(buf, i);
      if (!v) break;
      entry = { type: "varint", value: v[0] };
      i = v[1];
    } else if (wt === 2) {
      const l = readVarint(buf, i);
      if (!l) break;
      const [len, j] = l;
      if (j + len > buf.length) break;
      const slice = buf.subarray(j, j + len);
      entry = {
        type: "bytes",
        value: slice,
        text: Buffer.from(slice).toString("utf8"),
      };
      i = j + len;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      entry = { type: "fixed32", value: buf.readUInt32LE(i) };
      i += 4;
    } else {
      break;
    }
    if (!fields.has(fn)) fields.set(fn, []);
    fields.get(fn).push(entry);
  }
  return fields;
}

function firstText(fields, n) {
  const list = fields.get(n);
  if (!list) return null;
  for (const e of list) {
    if (e.type === "bytes" && typeof e.text === "string" && e.text.length)
      return e.text;
  }
  return null;
}

function firstVarint(fields, n) {
  const list = fields.get(n);
  if (!list) return null;
  for (const e of list) {
    if (e.type === "varint") return e.value;
  }
  return null;
}

/**
 * Decode one chat submessage payload into a normalized event, or null.
 * @param {Buffer|Uint8Array} payload
 * @param {object} meta
 */
export function decodeChatPayload(payload, meta = {}) {
  const buf = Buffer.from(payload);
  const fields = parseProto(buf);
  const text = firstText(fields, 4);
  if (!text) return null;

  const name = firstText(fields, 1);
  const playerId = firstText(fields, 2);
  const isSystem = !name;

  return {
    kind: isSystem ? "system" : "player",
    player: isSystem ? SYSTEM_PLAYER.name : name,
    playerId: isSystem ? SYSTEM_PLAYER.playerId : playerId,
    message: text,
    flag: firstVarint(fields, 6),
    ...meta,
  };
}

/**
 * Scan a raw WS frame for all chat (type 0x14) submessages.
 * @param {Buffer|Uint8Array} frame
 * @param {object} meta  e.g. { t, direction, seq, url }
 * @returns {object[]}
 */
export function decodeFrame(frame, meta = {}) {
  const buf = Buffer.from(frame);
  const out = [];
  for (let i = 0; i + 5 <= buf.length; i++) {
    if (
      buf[i] !== CHAT_TYPE ||
      buf[i + 1] !== 0 ||
      buf[i + 2] !== 0 ||
      buf[i + 3] !== 0
    ) {
      continue;
    }
    const len = buf[i + 4];
    if (len < 2 || len > 250 || i + 5 + len > buf.length) continue;
    const payload = buf.subarray(i + 5, i + 5 + len);
    const event = decodeChatPayload(payload, {
      ...meta,
      offset: i,
      payloadLen: len,
    });
    if (event) out.push(event);
  }
  return out;
}

/**
 * Decode a capture JSONL line / frame object from the userscript.
 * Supports v2 (`b64`) and v1 (`hex` preview — may be truncated).
 */
export function decodeCaptureFrame(obj) {
  if (obj.kind === "starbreak-ws-capture") return [];
  let buf;
  if (obj.b64) buf = Buffer.from(obj.b64, "base64");
  else if (obj.hex) {
    const parts = [];
    for (const tok of String(obj.hex).replace(/…/g, "").split(/\s+/)) {
      if (/^[0-9a-fA-F]{2}$/.test(tok)) parts.push(parseInt(tok, 16));
      else break;
    }
    buf = Buffer.from(parts);
  } else return [];

  return decodeFrame(buf, {
    t: obj.t,
    direction: obj.direction,
    seq: obj.seq,
    url: obj.url,
    frameLen: obj.length,
  });
}
