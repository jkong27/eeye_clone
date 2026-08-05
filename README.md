# Eschaton Eye clone — StarBreak chat logger

Decode lobby chat from the web client WebSocket and append to JSONL.
**SYSTEM** is a special player (`player_id = "SYSTEM"`) for announcements
(portal opens, clear messages, etc.).

## Layout

| Path                 | Purpose                                          |
| -------------------- | ------------------------------------------------ |
| `src/decode.js`      | Parse type `0x14` chat protobufs                 |
| `src/decode-file.js` | Offline: capture JSONL → chat events             |
| `src/logger.js`      | Playwright bot (persistent Chromium)             |
| `src/store.js`       | JSONL writer + Postgres schema helper            |
| `schema.sql`         | Postgres tables (`players`, `chat_messages`)     |
| `data/`              | Browser profile + live `chat.jsonl` (gitignored) |

## Setup

```bash
npm install
npx playwright install chromium
```

## Offline decode (validate Phase 1 captures)

```bash
npm run test:decode
# or:
node src/decode-file.js ./phase1-ws-capture/captures/starbreak-ws-1784880099832.jsonl
```

Expected from the lobby test capture:

- `<SYSTEM> Thetis has opened a portal to the Elite Fungus Cave`
- `<PlayerName (6400132109041664)> eeye-test-001`

## Live logger

```bash
node src/logger.js
```

1. Chromium opens Starbreak (profile saved under `data/browser-profile/`)
2. The logger clicks **Play** and waits for a real game-shard WebSocket
3. Chat lines print and append to `data/chat.jsonl`

The saved profile must already be signed in. Use `--manual` to restore the old
interactive setup flow when login, character, or server selection needs attention.

Stop with Ctrl+C.

```bash
node src/logger.js --headless          # after profile is logged in
node src/logger.js --out ./data/uswest.jsonl
node src/logger.js --schema            # print Postgres DDL
node src/logger.js --manual            # manually park the bot
node src/logger.js --play-delay-seconds 3
```

For unattended operation, set `DATABASE_URL`; the logger creates or updates
the schema at startup and writes to PostgreSQL and the local JSONL safety copy.
It sends brief opposing movement inputs every 12 minutes and reloads the page
when the game WebSocket closes or stops receiving traffic.

```bash
DATABASE_URL=postgresql://user:pass@host:5432/eeye node src/logger.js --headless
node src/logger.js --keepalive-minutes 12 --stale-seconds 90
```

The persistent browser profile must be logged in and parked in Eschaton before
headless operation. Both timers are configurable through the shown flags.

## Message shape

```json
{
  "t": "2026-07-24T08:01:33.955Z",
  "player": "PlayerName",
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

## Postgres

```bash
psql "$DATABASE_URL" -f schema.sql
```

The schema is also applied automatically when `DATABASE_URL` or
`--database-url` is provided. Players are upserted on sight and SYSTEM is
seeded by the schema.
