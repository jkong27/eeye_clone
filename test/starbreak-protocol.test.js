import assert from "node:assert/strict";
import test from "node:test";
import { splitServerTimeDelta } from "../src/direct-client.js";
import {
  encodeConnect,
  encodeInputPress,
  encodeInputRelease,
  encodeMessage,
  encodeServerDeltaAck,
  generateAnonymousSecret,
} from "../src/starbreak-protocol.js";

test("application messages use a one-byte type and big-endian length", () => {
  assert.equal(encodeMessage(0x16).toString("hex"), "1600000000");
  assert.equal(
    encodeServerDeltaAck(33).toString("hex"),
    "0f000000020821",
  );
});

test("input packets match the captured key press and release layouts", () => {
  assert.equal(encodeInputPress(256).toString("hex"), "0e00000003108002");
  assert.equal(encodeInputPress(1).toString("hex"), "0e000000021001");
  assert.equal(encodeInputRelease(1).toString("hex"), "0e000000021801");
});

test("control and game Connect protobufs match the captured layouts", () => {
  assert.equal(
    encodeConnect({ challenge: 0x12345678, timestamp: 0x01020304 }).toString("hex"),
    "0d785634121a008002018d0204030201",
  );
  assert.equal(
    encodeConnect({
      challenge: 0x12345678,
      secret: Buffer.from("abcdefghijkl"),
      timestamp: 0x01020304,
    }).toString("hex"),
    "0d785634123212120c6162636465666768696a6b6c300038018002018d0204030201920200",
  );
});

test("server time deltas are split into protocol-valid chunks", () => {
  assert.deepEqual(splitServerTimeDelta(20), [20]);
  assert.deepEqual(splitServerTimeDelta(50), [25, 25]);
  assert.deepEqual(splitServerTimeDelta(100), [33, 33, 33]);
  assert.ok(splitServerTimeDelta(1_000).every((value) => value <= 40));
});

test("anonymous secrets use the observed 12-character alphabet", () => {
  assert.match(generateAnonymousSecret(), /^[A-Za-z0-9]{12}$/);
});
