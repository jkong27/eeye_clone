const tabs = [...document.querySelectorAll("[role='tab']")];
const views = [...document.querySelectorAll("[role='tabpanel']")];
const recentStatus = document.querySelector("#recent-status");
const recentMessages = document.querySelector("#recent-messages");
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
let recentLoaded = false;

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function setActiveTab(tab, { focus = false } = {}) {
  for (const candidate of tabs) {
    const active = candidate === tab;
    candidate.setAttribute("aria-selected", String(active));
    candidate.tabIndex = active ? 0 : -1;
  }

  for (const view of views) {
    view.hidden = view.id !== tab.getAttribute("aria-controls");
  }

  if (focus) tab.focus();
  if (tab.dataset.view === "lookup" && !focus) searchInput.focus();
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

function messageRow(message, { showPlayer = false } = {}) {
  const row = document.createElement("article");
  row.className = `message${message.kind === "system" ? " system-message" : ""}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  if (showPlayer) {
    const author = document.createElement("strong");
    author.className = "message-author";
    author.textContent = message.kind === "system" ? "SYSTEM" : message.player;
    meta.append(author);
  }

  const time = document.createElement("time");
  const date = new Date(message.received_at);
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleString();
  meta.append(time);

  const text = document.createElement("p");
  text.textContent = message.message;
  row.append(meta, text);
  return row;
}

async function loadRecentMessages() {
  try {
    const data = await getJson("/api/recent-messages");
    recentMessages.replaceChildren();
    if (!data.messages.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No messages have been recorded yet.";
      recentMessages.append(empty);
    } else {
      recentMessages.append(...data.messages.map((message) =>
        messageRow(message, { showPlayer: true })));
    }
    recentStatus.hidden = true;
    recentLoaded = true;
  } catch (error) {
    recentStatus.hidden = false;
    recentStatus.textContent = error.message;
  }
}

async function loadMessages(append = false) {
  if (!selectedPlayer) return;
  if (append && !nextCursor) return;
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
      messages.append(...data.messages.map((message) => messageRow(message)));
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

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    setActiveTab(tab);
    if (tab.dataset.view === "recent" && !recentLoaded) loadRecentMessages();
  });
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (tabs.indexOf(tab) + offset + tabs.length) % tabs.length;
    setActiveTab(tabs[nextIndex], { focus: true });
    if (tabs[nextIndex].dataset.view === "recent" && !recentLoaded) loadRecentMessages();
  });
}

searchButton.addEventListener("click", searchPlayers);
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchPlayers();
});
loadMore.addEventListener("click", () => loadMessages(true));

loadRecentMessages();
