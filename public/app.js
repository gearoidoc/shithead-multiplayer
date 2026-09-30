/**
 * Lobby + presence client. Milestone 1: no game logic anywhere near here —
 * the room server owns all of that. This screen exists to create/join a room
 * by code and show who else is in it.
 *
 * Message shapes are documented in src/shared/protocol.ts.
 */

import { RoomSocket } from "./socket.js";

const MAX_PLAYERS = 4;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1
const CODE_LENGTH = 4;

const STORE_NAME = "shithead:name";
const STORE_PLAYER_ID = "shithead:playerId";

const el = {
  lobby: document.getElementById("lobby-screen"),
  room: document.getElementById("room-screen"),
  name: document.getElementById("name-input"),
  code: document.getElementById("code-input"),
  createBtn: document.getElementById("create-btn"),
  joinForm: document.getElementById("join-form"),
  lobbyError: document.getElementById("lobby-error"),
  roomCode: document.getElementById("room-code"),
  roomStatus: document.getElementById("room-status"),
  seatCount: document.getElementById("seat-count"),
  seatList: document.getElementById("seat-list"),
  copyBtn: document.getElementById("copy-btn"),
  leaveBtn: document.getElementById("leave-btn"),
  startBtn: document.getElementById("start-btn"),
  startHint: document.getElementById("start-hint"),
  roomError: document.getElementById("room-error"),
  app: document.getElementById("app"),
  table: document.getElementById("table-screen"),
  tableCode: document.getElementById("table-code"),
  tablePhase: document.getElementById("table-phase"),
  tableLeaveBtn: document.getElementById("table-leave-btn"),
  tableNote: document.getElementById("table-note"),
  tableError: document.getElementById("table-error"),
  opponents: document.getElementById("opponents"),
  drawPile: document.getElementById("draw-pile"),
  wastePile: document.getElementById("waste-pile"),
  ownName: document.getElementById("own-name"),
  ownUpcards: document.getElementById("own-upcards"),
  ownDowncards: document.getElementById("own-downcards"),
  ownHand: document.getElementById("own-hand"),
};

const state = {
  /** @type {RoomSocket|null} */ socket: null,
  /** @type {string|null} */ code: null,
  /** @type {string|null} */ you: null,
  /** Lobby roster, from a `room` message. */ room: null,
  /** The table from our point of view, from a `game` message. */ game: null,
  status: "connecting",
};

// ---------------------------------------------------------------------------
// Identity: a stable id per browser, so a reload can reclaim the same seat.
// ---------------------------------------------------------------------------

function playerId() {
  let id = localStorage.getItem(STORE_PLAYER_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORE_PLAYER_ID, id);
  }
  return id;
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function normaliseCode(raw) {
  return (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
}

// ---------------------------------------------------------------------------
// Joining / leaving
// ---------------------------------------------------------------------------

function showLobbyError(message) {
  el.lobbyError.textContent = message;
  el.lobbyError.hidden = !message;
}

function joinRoom(code) {
  const name = el.name.value.trim();
  if (!name) {
    showLobbyError("Pick a name first.");
    el.name.focus();
    return;
  }
  if (code.length !== CODE_LENGTH) {
    showLobbyError(`Room codes are ${CODE_LENGTH} characters.`);
    el.code.focus();
    return;
  }

  localStorage.setItem(STORE_NAME, name);
  showLobbyError("");

  state.code = code;
  state.you = null;
  state.room = null;
  state.game = null;
  location.hash = code;

  showScreen("room");
  el.roomCode.textContent = code;
  el.seatList.replaceChildren();
  el.seatCount.textContent = `(0/${MAX_PLAYERS})`;

  state.socket?.close();
  state.socket = new RoomSocket({
    // Room ids are case-sensitive on the server, so always connect lowercased.
    room: code.toLowerCase(),
    onMessage: handleServerMessage,
    onStatus: (status) => {
      state.status = status;
      // Re-announce ourselves on every (re)connect; the server treats a
      // known player id as reclaiming its existing seat.
      if (status === "open") {
        state.socket.send({ type: "join", playerId: playerId(), name });
      }
      renderStatus();
    },
  });
}

function leaveRoom({ error } = {}) {
  state.socket?.send({ type: "leave" });
  state.socket?.close();
  state.socket = null;
  state.code = null;
  state.you = null;
  state.room = null;
  state.game = null;

  history.replaceState(null, "", location.pathname + location.search);
  showScreen("lobby");
  showLobbyError(error ?? "");
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

function handleServerMessage(msg) {
  switch (msg.type) {
    case "welcome":
      state.you = msg.you;
      break;
    case "room":
      state.room = msg;
      state.game = null;
      showScreen("room");
      renderRoom();
      break;
    case "game":
      state.game = msg;
      showScreen("table");
      renderGame();
      break;
    case "error":
      if (msg.fatal) {
        // We can't hold a seat here at all; the server has closed us out.
        leaveRoom({ error: msg.message });
      } else {
        // A rejected action. We're still in the room, so just say so.
        showTransientError(msg.message);
      }
      break;
  }
  renderStatus();
}

/** Which of the three screens is showing. */
function showScreen(which) {
  el.lobby.hidden = which !== "lobby";
  el.room.hidden = which !== "room";
  el.table.hidden = which !== "table";
  el.app.classList.toggle("at-table", which === "table");
}

let transientTimer = null;

function showTransientError(message) {
  const target = state.game ? el.tableError : el.roomError;
  target.textContent = message;
  target.hidden = false;
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => {
    target.hidden = true;
  }, 4000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatus() {
  const { status, room, game } = state;

  // The status line belongs to the lobby screen; the table has its own bar.
  if (game) return;

  if (status === "connecting") {
    return setStatus("Connecting…", "warn");
  }
  if (status === "reconnecting") {
    return setStatus("Connection lost — reconnecting…", "bad");
  }
  if (status === "closed") {
    return setStatus("Disconnected.", "bad");
  }

  const seated = room?.players.length ?? 0;
  if (seated < 2) {
    return setStatus("Waiting for someone else to join — share the code.", "warn");
  }
  return setStatus(`${seated} players in the room.`, "");
}

function setStatus(text, tone) {
  el.roomStatus.textContent = text;
  el.roomStatus.className = `status${tone ? ` ${tone}` : ""}`;
}

function renderRoom() {
  const { room, you } = state;
  if (!room) return;

  el.roomCode.textContent = room.code;
  el.seatCount.textContent = `(${room.players.length}/${MAX_PLAYERS})`;

  const rows = room.players.map((player) => {
    const li = document.createElement("li");
    li.className = "seat" + (player.id === you ? " is-you" : "");

    const number = document.createElement("span");
    number.className = "seat-number";
    number.textContent = String(player.seat + 1);

    const name = document.createElement("span");
    name.className = "seat-name";
    name.textContent = player.name;

    li.append(number, name);

    if (player.id === you) li.append(badge("you"));
    if (player.id === room.hostId) li.append(badge("host", "host"));
    if (!player.connected) li.append(badge("away", "away"));

    return li;
  });

  // Empty seats, so it's obvious how many more can still join.
  for (let i = room.players.length; i < MAX_PLAYERS; i += 1) {
    const li = document.createElement("li");
    li.className = "seat is-empty";

    const number = document.createElement("span");
    number.className = "seat-number";
    number.textContent = String(i + 1);

    const name = document.createElement("span");
    name.className = "seat-name";
    name.textContent = "Empty seat";

    li.append(number, name);
    rows.push(li);
  }

  el.seatList.replaceChildren(...rows);

  // Only the host gets the button; everyone else is told who they're waiting on.
  const isHost = you && you === room.hostId;
  const enough = room.players.length >= 2;
  el.startBtn.hidden = !isHost;
  el.startBtn.disabled = !enough;

  if (isHost) {
    el.startHint.textContent = enough
      ? "You're the host — start when everyone's in."
      : "You need at least 2 players to start.";
  } else {
    const host = room.players.find((p) => p.id === room.hostId);
    el.startHint.textContent = host
      ? `Waiting for ${host.name} to start the game.`
      : "";
  }
}

const PHASE_TEXT = {
  swap: "Swap phase",
  playing: "In play",
  finished: "Game over",
};

/** A single card face, or its back. Mirrors the single-player markup. */
function cardEl(card, { faceDown = false, small = false } = {}) {
  const div = document.createElement("div");
  div.className = "card";
  if (small) div.classList.add("small");

  if (faceDown || !card) {
    div.classList.add("face-down");
    return div;
  }

  const red = card.suit === "♥" || card.suit === "♦";
  div.classList.add(red ? "red" : "black");
  div.textContent = card.rank + card.suit;
  return div;
}

/** `count` face-down backs, for cards we're not entitled to see. */
function cardBacks(count, options) {
  return Array.from({ length: count }, () => cardEl(null, { faceDown: true, ...options }));
}

function fillRow(row, children) {
  row.replaceChildren(...children);
  row.classList.toggle("is-empty", children.length === 0);
}

function renderGame() {
  const game = state.game;
  if (!game) return;

  el.tableCode.textContent = game.code;
  el.tablePhase.textContent = PHASE_TEXT[game.phase] ?? game.phase;

  const me = game.players.find((p) => p.id === game.you);
  const others = game.players.filter((p) => p.id !== game.you);

  // --- everyone else: up-cards face up, everything else as backs ---------
  el.opponents.replaceChildren(
    ...others.map((player) => {
      const box = document.createElement("div");
      box.className = "opponent" + (player.connected ? "" : " is-away");

      const head = document.createElement("div");
      head.className = "opponent-head";

      const name = document.createElement("span");
      name.className = "opponent-name";
      name.textContent = player.name;
      head.append(name);

      if (player.id === game.hostId) head.append(badge("host", "host"));
      if (!player.connected) head.append(badge("away", "away"));

      const counts = document.createElement("span");
      counts.className = "opponent-counts";
      counts.textContent = `${player.handCount} in hand · ${player.downcardCount} down`;
      head.append(counts);

      const upRow = document.createElement("div");
      upRow.className = "card-row";
      fillRow(upRow, [
        ...player.upcards.map((card) => cardEl(card, { small: true })),
        ...cardBacks(player.downcardCount, { small: true }),
      ]);

      box.append(head, upRow);
      return box;
    }),
  );

  // --- the middle ---------------------------------------------------------
  if (game.deckCount > 0) {
    el.drawPile.replaceChildren(cardEl(null, { faceDown: true }));
  } else {
    el.drawPile.textContent = "empty";
  }
  el.drawPile.title = `${game.deckCount} cards left in the draw pile`;

  if (game.wasteTop) {
    el.wastePile.replaceChildren(cardEl(game.wasteTop));
  } else {
    el.wastePile.textContent = "empty";
  }
  el.wastePile.title = `${game.wasteCount} cards in the pile`;

  // --- us: hand in full, our own down-cards still face down --------------
  el.ownName.textContent = me ? `${me.name} (you)` : "You";
  fillRow(el.ownUpcards, (me?.upcards ?? []).map((card) => cardEl(card)));
  fillRow(el.ownDowncards, cardBacks(me?.downcardCount ?? 0));
  fillRow(el.ownHand, game.hand.map((card) => cardEl(card)));

  el.tableNote.textContent =
    game.phase === "swap"
      ? "Dealt. Swapping hand cards with your face-up cards is the next step — " +
        "nothing is clickable yet."
      : "";
}

function badge(text, variant) {
  const span = document.createElement("span");
  span.className = `seat-badge${variant ? ` ${variant}` : ""}`;
  span.textContent = text;
  return span;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.createBtn.addEventListener("click", () => joinRoom(randomCode()));

el.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom(normaliseCode(el.code.value));
});

el.code.addEventListener("input", () => {
  el.code.value = normaliseCode(el.code.value);
});

el.leaveBtn.addEventListener("click", () => leaveRoom());
el.tableLeaveBtn.addEventListener("click", () => leaveRoom());

el.startBtn.addEventListener("click", () => {
  state.socket?.send({ type: "start-game" });
});

el.copyBtn.addEventListener("click", async () => {
  const link = `${location.origin}${location.pathname}#${state.code ?? ""}`;
  try {
    await navigator.clipboard.writeText(link);
    el.copyBtn.textContent = "Copied!";
  } catch {
    // Clipboard is blocked outside a secure context; show the link instead.
    el.copyBtn.textContent = link;
  }
  setTimeout(() => (el.copyBtn.textContent = "Copy invite link"), 1800);
});

// A deliberate close beats waiting for the socket to time out server-side.
window.addEventListener("pagehide", () => state.socket?.send({ type: "leave" }));

// Restore the remembered name, and honour an invite link's #CODE.
el.name.value = localStorage.getItem(STORE_NAME) ?? "";

const invited = normaliseCode(location.hash.slice(1));
if (invited.length === CODE_LENGTH) {
  el.code.value = invited;
  if (el.name.value) {
    joinRoom(invited);
  } else {
    showLobbyError("You've been invited — enter a name to join.");
    el.name.focus();
  }
} else {
  el.name.focus();
}
