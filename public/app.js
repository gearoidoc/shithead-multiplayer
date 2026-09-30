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
};

/** @type {{socket: RoomSocket|null, code: string|null, you: string|null, room: any, status: string}} */
const state = {
  socket: null,
  code: null,
  you: null,
  room: null,
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
  location.hash = code;

  el.lobby.hidden = true;
  el.room.hidden = false;
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

  history.replaceState(null, "", location.pathname + location.search);
  el.room.hidden = true;
  el.lobby.hidden = false;
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
      renderRoom();
      break;
    case "error":
      // The server only errors on things that make the room unusable for us.
      leaveRoom({ error: msg.message });
      break;
  }
  renderStatus();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatus() {
  const { status, room } = state;

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
