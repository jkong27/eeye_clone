# Phase 2 — StarBreak chat logger

Decode lobby chat from the web client WebSocket and append to JSONL.
**SYSTEM** is a special player (`player_id = "SYSTEM"`) for announcements
(portal opens, clear messages, etc.).

## Layout

| Path | Purpose |
|------|---------|
| `src/decode.js` | Parse type `0x14` chat protobufs |
| `src/decode-file.js` | Offline: capture JSONL → chat events |
| `src/logger.js` | Playwright bot (persistent Chromium) |
| `src/store.js` | JSONL writer + Postgres schema helper |
| `schema.sql` | Postgres tables (`players`, `chat_messages`) |
| `data/` | Browser profile + live `chat.jsonl` (gitignored) |

## Setup

```bash
cd phase2-chat-logger
npm install
npx playwright install chromium
```

## Offline decode (validate Phase 1 captures)

```bash
npm run test:decode
# or:
node src/decode-file.js ../phase1-ws-capture/captures/starbreak-ws-1784880099832.jsonl
```

Expected from the lobby test capture:

- `<SYSTEM> Thetis has opened a portal to the Elite Fungus Cave`
- `<DaddyMao (6400132109041664)> eeye-test-001`

## Live logger

```bash
node src/logger.js
```

1. Chromium opens Starbreak (profile saved under `data/browser-profile/`)
2. Log in and park the character in **Eschaton**
3. Press Enter in the terminal
4. Chat lines print and append to `data/chat.jsonl`

Stop with Ctrl+C.

```bash
node src/logger.js --headless          # after profile is logged in
node src/logger.js --out ./data/uswest.jsonl
node src/logger.js --schema            # print Postgres DDL
```

## Message shape

```json
{
  "t": "2026-07-24T08:01:33.955Z",
  "player": "DaddyMao",
  "player_id": "6400132109041664",
  "kind": "player",
  "message": "eeye-test-001",
  "server_url": "wss://….sbmach.com:443/",
  "flag": null
}
```

System example:

```json
{
  "player": "SYSTEM",
  "player_id": "SYSTEM",
  "kind": "system",
  "message": "Thetis has opened a portal to the Elite Fungus Cave"
}
```

## Postgres (optional, later)

```bash
psql "$DATABASE_URL" -f schema.sql
```

Upsert real players on first sighting; SYSTEM is seeded by the schema.
