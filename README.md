Eschaton Eye clone — Starbreak chat logging via the web client.

## Phase 1 (done)

[phase1-ws-capture/](phase1-ws-capture/) — WebSocket capture userscript; chat is plaintext protobuf (`0x14`).

## Phase 2 (current)

[phase2-chat-logger/](phase2-chat-logger/) — decoder + Playwright logger.

- Player chat → real `player` / `player_id`
- Announcements → special player **SYSTEM** (`player_id = "SYSTEM"`)
