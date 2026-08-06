# Eschaton Eye clone

An always-on StarBreak lobby chat collector with PostgreSQL storage and a
read-only player search UI. Player chat is stored under the real player name
and ID. Game announcements use the special player ID `SYSTEM`.

## Architecture

```text
StarBreak web client -> Playwright collector -> PostgreSQL <- Query UI/API
                              |
                              +-> data/chat.jsonl safety copy
```

| Path | Purpose |
| --- | --- |
| `src/logger.js` | Playwright collector, reconnect loop, and activity keepalive |
| `src/ws-hook.js` | Browser-side WebSocket observer |
| `src/decode.js` | Type `0x14` chat protobuf decoder |
| `src/decode-file.js` | Offline capture decoder |
| `src/store.js` | JSONL and PostgreSQL storage |
| `src/server.js` | Read-only UI/API server |
| `public/` | Player search frontend |
| `schema.sql` | PostgreSQL schema |
| `data/` | Browser profile, JSONL log, and health state (ignored by Git) |
| `Dockerfile.collector` | Playwright collector image |
| `Dockerfile.ui` | Lightweight UI/API image |
| `compose.yaml` | PostgreSQL, UI, and gated collector services |
| `phase1-ws-capture/` | Protocol research artifacts |

## Local setup

Requirements:

- Node.js 24 or another version supporting `--env-file-if-exists`
- PostgreSQL
- Chromium installed through Playwright

Install dependencies and the browser:

```bash
npm install
npx playwright install chromium
```

Create `.env` from `.env.example` and provide a real password. The local setup
supports PostgreSQL's standard split variables:

```dotenv
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=eeye
PGUSER=eeye_app
PGPASSWORD=replace-with-a-long-random-password
```

`DATABASE_URL` is also supported and takes precedence when present. It is
useful for managed/cloud PostgreSQL:

```dotenv
DATABASE_URL=postgresql://user:password@host:5432/eeye
```

Never commit `.env`; it is ignored by Git.

## Run the collector locally

```bash
npm run logger
```

The collector:

1. Reuses `data/browser-profile/`.
2. Opens StarBreak and waits briefly for the canvas menu to stabilize.
3. Clicks Play and retries until a game-shard WebSocket opens.
4. Writes each decoded event to PostgreSQL and `data/chat.jsonl`.
5. Sends brief opposing movement inputs every 12 minutes.
6. Reconnects with capped backoff after a socket or network failure.

The saved browser profile must already be signed in. Use `--manual` when login,
character selection, or server selection needs attention.

```bash
npm run logger -- --manual
npm run logger -- --headless
npm run logger -- --out ./data/uswest.jsonl
npm run logger -- --keepalive-minutes 12 --stale-seconds 90
npm run logger -- --play-delay-seconds 3
npm run logger -- --schema
```

Both `DATABASE_URL` and the split `PG*` variables enable PostgreSQL. The logger
applies the schema at startup. Without either configuration, it writes only the
JSONL safety copy.

Stop the collector with Ctrl+C.

## Run the query UI locally

```bash
npm run ui
```

Open `http://127.0.0.1:3000`. The UI searches non-SYSTEM players by name or
exact player ID and displays paginated chat history. API queries are
parameterized and do not return the raw event payload.

The local server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only when
you intentionally want it reachable through the machine's network interfaces.

## Docker Compose

Requirements:

- Docker Desktop or another Linux Docker engine
- A `.env` containing `PGDATABASE`, `PGUSER`, and `PGPASSWORD`

Start the containerized PostgreSQL 17 database and UI:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f ui
```

Open `http://127.0.0.1:3000` (or the port set by `UI_PORT`). PostgreSQL is kept
on an internal Docker network and is not published to the host.

Compose uses its own persistent `eeye_postgres_data` volume. It does not read
the existing host PostgreSQL database. Until the migration/cutover step is
completed, this container database contains only newly imported or
container-collected data.

The collector is intentionally behind the `collector` profile because a fresh
Linux Chromium profile must be logged in first:

```bash
docker compose --profile collector up -d collector
```

Do not start that profile before completing the container login bootstrap. Its
browser profile and JSONL data persist in `eeye_collector_data`. The collector
image is health-checked using live game-shard traffic; the UI health check also
verifies its database connection.

Useful Compose commands:

```bash
docker compose ps
docker compose logs -f postgres ui
docker compose stop
docker compose up -d
```

## Offline capture decode

```bash
npm run test:decode
# or
node src/decode-file.js ./phase1-ws-capture/captures/starbreak-ws-1784880099832.jsonl
```

The known fixture should decode a SYSTEM portal announcement and the player
message `eeye-test-001`.

## Stored message shape

```json
{
  "t": "2026-07-24T08:01:33.955Z",
  "player": "PlayerName",
  "player_id": "6400132109041664",
  "kind": "player",
  "message": "eeye-test-001",
  "server_url": "wss://example.sbmach.com:443/",
  "flag": null
}
```

Control characters are normalized in the queryable message and console output.
The original decoded message remains available in PostgreSQL's `raw` JSON.

## Current deployment status

- Local collector: working with automatic entry, keepalive, and reconnection.
- Local PostgreSQL and UI: working.
- Collector image: built and Chromium smoke-tested.
- UI image: built and smoke-tested.
- Compose PostgreSQL and UI: running and health-checked.
- Container login bootstrap: next step.
- Host database migration and cloud deployment: not completed yet.
