# Eschaton Eye clone

An always-on StarBreak lobby chat collector with PostgreSQL storage and a
read-only player search UI. Player chat is stored under the real player name
and ID. Game announcements use the special player ID `SYSTEM`.

## Architecture

```text
StarBreak WebSocket -> direct Node collector -> PostgreSQL <- Query UI/API
```

| Path | Purpose |
| --- | --- |
| `src/direct-logger.js` | Production collector, PostgreSQL writes, and reconnect loop |
| `src/direct-client.js` | Anonymous handshake, tutorial bypass, protocol ACKs, and keepalive |
| `src/starbreak-protocol.js` | WebSocket framing, protobuf encoding, and RSA handshake |
| `src/decode.js` | Type `0x14` chat protobuf decoder |
| `src/decode-file.js` | Offline capture decoder |
| `src/store.js` | PostgreSQL storage and message normalization |
| `src/server.js` | Read-only UI/API server |
| `public/` | Player search frontend |
| `schema.sql` | PostgreSQL schema |
| `data/` | Runtime collector health state (ignored by Git) |
| `Dockerfile.collector` | Lightweight direct collector image |
| `Dockerfile.ui` | Lightweight UI/API image |
| `compose.yaml` | PostgreSQL, UI, and profile-gated collector services |
| `phase1-ws-capture/` | Protocol research artifacts |

## Local setup

Requirements:

- Node.js 24 or another version supporting `--env-file-if-exists`
- PostgreSQL

Install dependencies:

```bash
npm install
```

If Windows PowerShell blocks the `npm.ps1` shim because of its execution
policy, use `npm.cmd` for the same commands.

Create `.env` from `.env.example` and provide a real password. The local setup
supports PostgreSQL's standard split variables:

```dotenv
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=eeye
PGUSER=eeye_app
PGPASSWORD=replace-with-a-long-random-password
KEEPALIVE_MINUTES=12
STALE_SECONDS=90
```

The same `.env` file supplies Compose-only settings such as `UI_PORT` and
`COLLECTOR_CPUS`; their defaults are shown in `.env.example`.

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

1. Opens the StarBreak matchmaking WebSocket and performs the anonymous RSA
   handshake directly from Node.
2. Connects to the assigned game shard and enters the world without Chromium.
3. Detects and bypasses the tutorial before entering Eschaton.
4. Maintains the protocol clock and acknowledges inbound world deltas.
5. Writes each decoded event to PostgreSQL.
6. Sends brief opposing-movement packets every 12 minutes to reset the
   15-minute inactivity timer.
7. Reconnects with capped backoff after a socket or network failure.

StarBreak creates an anonymous session; no account creation, login bootstrap,
or persistent browser profile is required. Each collector process starts with
a new in-memory anonymous identity and reuses it for reconnect attempts during
that process.

Both `DATABASE_URL` and the split `PG*` variables enable PostgreSQL. The logger
requires PostgreSQL configuration and applies the schema at startup.
`KEEPALIVE_MINUTES` and `STALE_SECONDS` can be set in `.env`.

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
- A `.env` containing `PGPASSWORD`; `PGDATABASE` and `PGUSER` have defaults

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
`docker compose down --volumes` permanently deletes it. The collector is
stateless and does not use a data volume.

The collector is behind the `collector` profile so the database and UI can be
run independently:

```bash
docker compose --profile collector up -d collector
```

The direct collector is limited to one CPU core by default and normally uses
only a small fraction of it. Set `COLLECTOR_CPUS` in `.env` to override the
limit.

The collector image is health-checked using recent live game-shard traffic;
the UI health check also verifies its database connection.

Useful Compose commands:

```bash
# Start PostgreSQL and the UI only (services without a profile).
docker compose up -d

# Start PostgreSQL, the UI, and the direct collector.
docker compose --profile collector up -d

# Rebuild images before starting all three services.
docker compose --profile collector up -d --build

docker compose ps
docker compose logs -f postgres ui collector
docker compose --profile collector stop
```

The direct `collector` service uses the `collector` profile. PostgreSQL and
the UI have no profile, so Compose starts them by default. The collector does
not maintain a persistent StarBreak profile.

## Offline capture decode

```bash
npm run test:decode
# or
node src/decode-file.js ./phase1-ws-capture/captures/starbreak-ws-1784880099832.jsonl
```

The known fixture should decode a SYSTEM portal announcement and the player
message `eeye-test-001`. Capture JSONL files are protocol-research artifacts;
the production collector writes chat only to PostgreSQL.

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

- Local collector: validated with anonymous entry, tutorial bypass, protocol
  maintenance, PostgreSQL writes, and reconnection.
- Local PostgreSQL and UI: validated.
- Collector image: Node-only and does not contain Chromium.
- UI image: built and smoke-tested.
- Compose PostgreSQL, UI, and collector: health-checked locally.
- Direct collector protocol: entered Eschaton and decoded both SYSTEM and real
  player chat.
- Cloud deployment: not completed yet.
