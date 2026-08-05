const searchInput = document.querySelector("#search");
const searchButton = document.querySelector("#search-button");
const status = document.querySelector("#status");
const players = document.querySelector("#players");
const history = document.querySelector("#history");
const playerName = document.querySelector("#player-name");
const playerId = document.querySelector("#player-id");
const messageCount = document.querySelector("#message-count");
const messages = document.querySelector("#messages");
const loadMore = document.querySelector("#load-more");

let selectedPlayer = null;
let nextCursor = null;

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function resultButton(player) {
  const button = document.createElement("button");
  button.className = "player-result";
  button.type = "button";
  const identity = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = player.name;
  const id = document.createElement("span");
  id.textContent = ` · ${player.player_id}`;
  identity.append(name, id);
  const count = document.createElement("span");
  count.textContent = `${player.message_count} message${player.message_count === 1 ? "" : "s"}`;
  button.append(identity, count);
  button.addEventListener("click", () => selectPlayer(player));
  return button;
}

async function searchPlayers() {
  const query = searchInput.value.trim();
  searchButton.disabled = true;
  status.textContent = "Searching archive…";
  players.replaceChildren();
  try {
    const data = await getJson(`/api/players?q=${encodeURIComponent(query)}`);
    status.textContent = data.players.length
      ? `${data.players.length} player${data.players.length === 1 ? "" : "s"} found.`
      : "No matching players found.";
    players.append(...data.players.map(resultButton));
  } catch (error) {
    status.textContent = error.message;
  } finally {
    searchButton.disabled = false;
  }
}

function messageRow(message) {
  const row = document.createElement("article");
  row.className = "message";
  const time = document.createElement("time");
  const date = new Date(message.received_at);
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleString();
  const text = document.createElement("p");
  text.textContent = message.message;
  row.append(time, text);
  return row;
}

async function loadMessages(append = false) {
  if (!selectedPlayer) return;
  loadMore.disabled = true;
  const cursor = append && nextCursor ? `&before=${encodeURIComponent(nextCursor)}` : "";
  try {
    const data = await getJson(
      `/api/messages?player_id=${encodeURIComponent(selectedPlayer.player_id)}&limit=100${cursor}`,
    );
    if (!append) messages.replaceChildren();
    if (!data.messages.length && !append) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No messages recorded for this player.";
      messages.append(empty);
    } else {
      messages.append(...data.messages.map(messageRow));
    }
    nextCursor = data.next_cursor;
    loadMore.hidden = !nextCursor;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    loadMore.disabled = false;
  }
}

async function selectPlayer(player) {
  selectedPlayer = player;
  playerName.textContent = player.name;
  playerId.textContent = player.player_id;
  messageCount.textContent = `${player.message_count} RECORDED`;
  history.hidden = false;
  history.scrollIntoView({ behavior: "smooth", block: "start" });
  await loadMessages(false);
}

searchButton.addEventListener("click", searchPlayers);
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchPlayers();
});
loadMore.addEventListener("click", () => loadMessages(true));
