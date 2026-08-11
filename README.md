# Eschaton Eye clone

An always-on StarBreak lobby chat collector with PostgreSQL storage and a
read-only player search UI. Player chat is stored under the real player name
and ID. Game announcements use the special player ID `SYSTEM`.

## Architecture

```text
StarBreak web client -> Playwright collector -> PostgreSQL <- Query UI/API
```

| Path | Purpose |
| --- | --- |
| `src/logger.js` | Playwright collector, reconnect loop, and activity keepalive |
| `src/ws-hook.js` | Browser-side WebSocket observer |
| `src/decode.js` | Type `0x14` chat protobuf decoder |
| `src/decode-file.js` | Offline capture decoder |
| `src/store.js` | PostgreSQL storage and message normalization |
| `src/server.js` | Read-only UI/API server |
| `public/` | Player search frontend |
| `schema.sql` | PostgreSQL schema |
| `data/` | Runtime collector health state (ignored by Git) |
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

If Windows PowerShell blocks the `npm.ps1` shim because of its execution
policy, use `npm.cmd` and `npx.cmd` for the same commands.

Create `.env` from `.env.example` and provide a real password. The local setup
supports PostgreSQL's standard split variables:

```dotenv
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=eeye
PGUSER=eeye_app
PGPASSWORD=replace-with-a-long-random-password
UI_PORT=3000
VNC_PORT=6080
COLLECTOR_CPUS=2.0
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

1. Creates a fresh anonymous browser context.
2. Opens StarBreak and waits briefly for the canvas menu to stabilize.
3. Clicks Play and retries until a game-shard WebSocket opens.
4. Detects the tutorial during initial shard loading and presses `H` to skip it.
5. Writes each decoded event to PostgreSQL.
6. Attempts a brief opposing-movement keepalive every 12 minutes.
7. Reconnects with capped backoff after a socket or network failure.

StarBreak creates an anonymous session; no account creation, login bootstrap,
or persistent browser profile is required. Each collector process starts with
a new anonymous identity. Use `--manual` only when game state needs interactive
attention.

```bash
npm run logger -- --manual
npm run logger -- --headless
npm run logger -- --keepalive-minutes 12 --stale-seconds 90
npm run logger -- --play-delay-seconds 3
npm run logger -- --schema
```

Both `DATABASE_URL` and the split `PG*` variables enable PostgreSQL. The logger
requires PostgreSQL configuration and applies the schema at startup.

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

Compose stores container-collected messages in the persistent
`eeye_postgres_data` volume. It does not read the existing host PostgreSQL
database. Recreating containers or images preserves the database; running
`docker compose down --volumes` permanently deletes it. The collectors are
stateless and do not use a data volume.

The collector is behind the `collector` profile so the database and UI can be
run independently:

```bash
docker compose --profile collector up -d collector
```

Both collector modes are limited to two CPU cores by default because Chromium
renders StarBreak's WebGL graphics through software inside Docker. Set
`COLLECTOR_CPUS` in `.env` to override the limit.

The collector image is health-checked using recent live game-shard traffic;
the UI health check also verifies its database connection.

For visual debugging, stop the headless collector and start the VNC-enabled
collector:

```bash
docker compose --profile collector stop collector
docker compose --profile debug up -d collector-vnc
```

Open `http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale`. When
finished, switch back to the headless collector. The VNC collector enables
bounded protocol diagnostics by default, so its logs are intentionally more
verbose:

```bash
docker compose --profile debug stop collector-vnc
docker compose --profile collector up -d collector
```

The noVNC port is unauthenticated but is published only on `127.0.0.1`. Do not
change that binding to a public interface. Avoid running `collector-vnc` and
`collector` together because that creates two independent collectors and may
store duplicate messages.

Useful Compose commands:

```bash
# Start PostgreSQL and the UI only (services without a profile).
docker compose up -d

# Start PostgreSQL, the UI, and the headless collector.
docker compose --profile collector up -d

# Rebuild images before starting all three services.
docker compose --profile collector up -d --build

docker compose ps
docker compose logs -f postgres ui
docker compose stop
```

Compose profiles are declared in `compose.yaml`. The headless `collector`
service uses the `collector` profile, and the headed `collector-vnc` service
uses the `debug` profile. PostgreSQL and the UI have no profile, so Compose
starts them by default.

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

- Local collector: working with anonymous automatic entry, tutorial skipping,
  PostgreSQL writes, and reconnection.
- Local PostgreSQL and UI: working.
- Collector image: built and Chromium smoke-tested.
- UI image: built and smoke-tested.
- Compose PostgreSQL, UI, and collector: running and health-checked.
- Optional visual collector debugging: working through localhost-only noVNC.
- Linux headless collector: entering Eschaton anonymously and storing messages.
- Recurring abnormal WebSocket `1006` disconnects under the two-core collector
  limit are still under investigation; first-attempt reconnection is working.
- Cloud deployment: not completed yet.
