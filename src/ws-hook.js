/**
 * Injected into the Starbreak page (Playwright). Hooks WebSocket and
 * posts frames that may contain chat (type 0x14) to window.__eeyeOnWsFrame.
 */
export const WS_HOOK_SOURCE = `(() => {
  if (window.__eeyeWsHooked) return;
  window.__eeyeWsHooked = true;

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof Blob !== "undefined" && data instanceof Blob) return null; // async path
    if (typeof data === "string") return new TextEncoder().encode(data);
    return null;
  }

  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /** Cheap scan: chat submessages are u32le 0x14. */
  function maybeHasChat(bytes) {
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (
        bytes[i] === 0x14 &&
        bytes[i + 1] === 0 &&
        bytes[i + 2] === 0 &&
        bytes[i + 3] === 0
      ) {
        return true;
      }
    }
    return false;
  }

  async function emit(urlStr, data) {
    const handler = window.__eeyeOnWsFrame;
    if (!handler) return;
    let bytes = toBytes(data);
    if (!bytes && typeof Blob !== "undefined" && data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    }
    if (!bytes || !maybeHasChat(bytes)) return;
    handler({
      t: new Date().toISOString(),
      direction: "in",
      url: urlStr,
      b64: bytesToBase64(bytes),
    });
  }

  const Native = window.WebSocket;
  function Wrapped(url, protocols) {
    const ws = protocols ? new Native(url, protocols) : new Native(url);
    const urlStr = String(url);
    let lastActivityNotice = 0;
    console.log("[eeye] ws open", urlStr);
    ws.addEventListener("open", () => {
      window.__eeyeOnWsStatus?.({ type: "open", url: urlStr, t: new Date().toISOString() });
    });
    ws.addEventListener("close", (event) => {
      window.__eeyeOnWsStatus?.({ type: "close", url: urlStr,
        t: new Date().toISOString(), code: event.code, reason: event.reason });
    });
    ws.addEventListener("error", () => {
      window.__eeyeOnWsStatus?.({ type: "error", url: urlStr, t: new Date().toISOString() });
    });
    ws.addEventListener("message", (ev) => {
      if (Date.now() - lastActivityNotice > 5000) {
        lastActivityNotice = Date.now();
        window.__eeyeOnWsActivity?.({ url: urlStr, t: new Date().toISOString() });
      }
      emit(urlStr, ev.data).catch(() => {});
    });
    return ws;
  }
  Wrapped.prototype = Native.prototype;
  Wrapped.CONNECTING = Native.CONNECTING;
  Wrapped.OPEN = Native.OPEN;
  Wrapped.CLOSING = Native.CLOSING;
  Wrapped.CLOSED = Native.CLOSED;

  window.WebSocket = Wrapped;
  console.log("[eeye] websocket hook installed");
})();`;
