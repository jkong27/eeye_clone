#!/bin/sh
set -eu

export DISPLAY=:99

cleanup() {
  kill "${NODE_PID:-}" "${NOVNC_PID:-}" "${VNC_PID:-}" \
    "${WM_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb :99 -screen 0 1280x800x24 -ac -nolisten tcp &
XVFB_PID=$!

# Do not let Chromium race the X server during container startup.
attempt=0
until [ -S /tmp/.X11-unix/X99 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo "[eeye] Xvfb did not become ready" >&2
    exit 1
  fi
  sleep 0.1
done

fluxbox >/tmp/fluxbox.log 2>&1 &
WM_PID=$!
x11vnc -display :99 -localhost -forever -shared -nopw -rfbport 5900 \
  >/tmp/x11vnc.log 2>&1 &
VNC_PID=$!
websockify --web=/usr/share/novnc 6080 localhost:5900 \
  >/tmp/novnc.log 2>&1 &
NOVNC_PID=$!

node src/logger.js --headed &
NODE_PID=$!
wait "$NODE_PID"
