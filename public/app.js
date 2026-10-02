/**
 * The browser client: lobby, room, and the table. No game logic is
 * authoritative here — the room server owns all of that. The one rule this
 * file knows, `canPlay`, only decides which cards to highlight; the server
 * checks every move regardless.
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
  readyBtn: document.getElementById("ready-btn"),
  swapHint: document.getElementById("swap-hint"),
  wasteLabel: document.getElementById("waste-label"),
  eventLine: document.getElementById("event-line"),
  results: document.getElementById("results"),
  playControls: document.getElementById("play-controls"),
  playBtn: document.getElementById("play-btn"),
  pickupBtn: document.getElementById("pickup-btn"),
};

const state = {
  /** @type {RoomSocket|null} */ socket: null,
  /** @type {string|null} */ code: null,
  /** @type {string|null} */ you: null,
  /** Lobby roster, from a `room` message. */ room: null,
  /** The table from our point of view, from a `game` message. */ game: null,
  /** Hand card picked for a swap, awaiting an up-card. Index, or null. */
  selectedHandIndex: null,
  /** Cards picked to play this turn, by key ("10♥"). All one rank. */
  selected: new Set(),
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
      // Indices are only meaningful against the state they were read from.
      if (msg.phase !== "swap") state.selectedHandIndex = null;
      pruneSelection();
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

const cardKey = (card) => `${card.rank}${card.suit}`;

/**
 * Display only: which cards to highlight as playable. The same rule as
 * `canPlayCard` in src/rules.ts — but the server re-checks every move, so
 * getting this wrong costs a refused move, never a cheat.
 */
function canPlay(card, top) {
  if (!top) return true;
  if (card.rank === "2" || card.rank === "8" || card.rank === "10") return true;
  if (top.rank === "7") return card.value <= 7 || ["2", "7", "8", "10"].includes(card.rank);
  if (card.rank === "7") return top.value <= 7;
  if (top.rank === "2") return true;
  return card.value >= top.value;
}

/** The zone this player must play from: hand, then up-cards, then blind. */
function activeSource(game, me) {
  if (game.hand.length > 0) return "hand";
  if ((me?.upcards.length ?? 0) > 0) return "upcards";
  if ((me?.downcardCount ?? 0) > 0) return "downcards";
  return null;
}

function isMyTurn(game) {
  return game.phase === "playing" && game.currentPlayerId === game.you;
}

/** Drop selected cards we no longer hold in the zone we play from. */
function pruneSelection() {
  const game = state.game;
  if (!game || !isMyTurn(game)) return state.selected.clear();
  const me = game.players.find((p) => p.id === game.you);
  const source = activeSource(game, me);
  const pool = source === "hand" ? game.hand : source === "upcards" ? me.upcards : [];
  const held = new Set(pool.map(cardKey));
  for (const key of state.selected) if (!held.has(key)) state.selected.delete(key);
}

const ORDINALS = ["1st", "2nd", "3rd", "4th"];

/** One line on what the last move did, for everyone at the table. */
function describeEvent(game) {
  const event = game.lastEvent;
  if (!event) return "";
  const who = event.playerId === game.you
    ? "You"
    : game.players.find((p) => p.id === event.playerId)?.name ?? "Someone";
  const cards = event.cards.map(cardKey).join(" ");

  let text;
  switch (event.kind) {
    case "play":
      text = `${who} played ${cards}`;
      break;
    case "blind-play":
      text = `${who} turned over ${cards} — and it goes`;
      break;
    case "blind-fail":
      text = `${who} turned over ${cards} — no good, picked up ${event.pickedUp}`;
      break;
    case "pick-up":
      text = `${who} picked up the pile (${event.pickedUp})`;
      break;
  }
  if (event.burned) text += " — burned the pile!";
  if (event.reversed) text += " — direction reversed";
  if (event.place) {
    text += ` — ${who === "You" ? "you're" : `${who} is`} out in ${ORDINALS[event.place - 1]}`;
  } else if (event.goAgain) {
    text += ` — ${who === "You" ? "go" : "goes"} again`;
  }
  return text + ".";
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
      if (player.id === game.currentPlayerId) box.classList.add("is-turn");

      const head = document.createElement("div");
      head.className = "opponent-head";

      const name = document.createElement("span");
      name.className = "opponent-name";
      name.textContent = player.name;
      head.append(name);

      if (player.id === game.currentPlayerId) head.append(badge("their turn", "turn"));
      if (player.place) head.append(badge(ORDINALS[player.place - 1], "place"));
      if (player.id === game.shitheadId) head.append(badge("shithead", "shithead"));
      if (game.phase === "swap" && player.ready) head.append(badge("ready", "ready"));
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

  // The top few cards, fanned, so a four-of-a-kind building is visible.
  if (game.wasteRecent.length > 0) {
    el.wastePile.replaceChildren(...game.wasteRecent.map((card) => cardEl(card)));
  } else {
    el.wastePile.textContent = game.burnedCount > 0 ? "burned" : "empty";
  }
  el.wastePile.title = `${game.wasteCount} cards in the pile`;
  el.wasteLabel.textContent = game.wasteCount > 0 ? `Pile (${game.wasteCount})` : "Pile";

  el.eventLine.textContent = describeEvent(game);

  // --- us: hand in full, our own down-cards still face down --------------
  el.ownName.textContent = me ? `${me.name} (you)` : "You";

  const swapping = game.phase === "swap";
  const selected = state.selectedHandIndex;
  const myTurn = isMyTurn(game);
  const source = activeSource(game, me);

  /** A card in the zone we play from: tap to pick it (one rank at a time). */
  const playable = (card) => {
    const div = cardEl(card);
    if (!canPlay(card, game.wasteTop)) div.classList.add("unplayable");
    div.classList.add("clickable");
    if (state.selected.has(cardKey(card))) div.classList.add("selected");
    div.addEventListener("click", () => toggleSelected(card));
    return div;
  };

  if (swapping) {
    // Pick a hand card, then the up-card to trade it for. Indices, so the
    // hand is shown in the server's order.
    fillRow(
      el.ownHand,
      game.hand.map((card, index) => {
        const div = cardEl(card);
        div.classList.add("clickable");
        if (index === selected) div.classList.add("selected");
        div.addEventListener("click", () => {
          state.selectedHandIndex = selected === index ? null : index;
          renderGame();
        });
        return div;
      }),
    );
  } else {
    // In play, cards are sent by identity, so the hand can be sorted.
    const sorted = [...game.hand].sort((a, b) => a.value - b.value);
    fillRow(
      el.ownHand,
      sorted.map((card) => (myTurn && source === "hand" ? playable(card) : cardEl(card))),
    );
  }

  fillRow(
    el.ownUpcards,
    (me?.upcards ?? []).map((card, index) => {
      if (myTurn && source === "upcards") return playable(card);

      const div = cardEl(card);
      if (!swapping || selected === null) return div;

      div.classList.add("clickable");
      div.addEventListener("click", () => {
        state.socket?.send({
          type: "swap",
          handIndex: selected,
          upcardIndex: index,
        });
        state.selectedHandIndex = null;
      });
      return div;
    }),
  );

  // Face-down cards, played blind: one tap turns one over.
  fillRow(
    el.ownDowncards,
    cardBacks(me?.downcardCount ?? 0).map((div, index) => {
      if (!myTurn || source !== "downcards") return div;
      div.classList.add("clickable");
      div.title = "Turn this one over";
      div.addEventListener("click", () => state.socket?.send({ type: "play-blind", index }));
      return div;
    }),
  );

  if (me?.place) {
    el.ownName.textContent += ` — out in ${ORDINALS[me.place - 1]}`;
  } else if (me && me.id === game.shitheadId) {
    el.ownName.textContent += " — shithead!";
  }

  // --- play controls ------------------------------------------------------
  el.playControls.hidden = !myTurn;
  if (myTurn) {
    el.playBtn.hidden = source === "downcards";
    el.playBtn.disabled = state.selected.size === 0;
    el.playBtn.textContent = state.selected.size > 1 ? `Play ${state.selected.size}` : "Play";
    el.pickupBtn.disabled = game.wasteCount === 0;
  }

  // --- swap controls ------------------------------------------------------
  el.readyBtn.hidden = !swapping;
  if (swapping) {
    el.readyBtn.textContent = me?.ready ? "Ready — change my mind" : "I'm done swapping";
    el.readyBtn.classList.toggle("is-ready", !!me?.ready);

    const waiting = game.players.filter((p) => p.connected && !p.ready).length;
    el.swapHint.textContent = me?.ready
      ? waiting === 0
        ? "Everyone's ready."
        : `Waiting for ${waiting} other ${waiting === 1 ? "player" : "players"}.`
      : selected === null
        ? "Swap any hand card for one of your face-up cards: pick a hand card first."
        : "Now pick the face-up card to trade it for.";
  } else if (myTurn) {
    el.swapHint.textContent =
      source === "downcards"
        ? "Down to your face-down cards: tap one to turn it over."
        : `Pick one or more cards of the same rank${source === "upcards" ? " from your face-up cards" : ""}, then play — or pick up the pile.`;
  } else {
    el.swapHint.textContent = "";
  }

  // --- whose turn ---------------------------------------------------------
  if (game.phase === "playing") {
    const current = game.players.find((p) => p.id === game.currentPlayerId);
    el.tablePhase.textContent = current
      ? current.id === game.you
        ? "Your turn"
        : `${current.name}'s turn`
      : "In play";
    // Direction only means anything with three or more at the table.
    if (game.players.length > 2) {
      el.tablePhase.textContent += game.turnDirection === 1 ? " · play order ↻" : " · reversed ↺";
    }
  }

  // --- the end ------------------------------------------------------------
  const over = game.phase === "finished";
  el.results.hidden = !over;
  if (over) {
    const nameOf = (id) => {
      const name = game.players.find((p) => p.id === id)?.name ?? "?";
      return id === game.you ? `${name} (you)` : name;
    };
    el.results.replaceChildren(
      ...game.finishOrder.map((id, i) => resultRow(ORDINALS[i], nameOf(id))),
      ...(game.shitheadId ? [resultRow("💩", `${nameOf(game.shitheadId)} — the shithead`)] : []),
    );
  }

  el.tableNote.textContent = over ? "Leave the table to start another game." : "";
}

function resultRow(place, text) {
  const li = document.createElement("li");
  const badgeEl = document.createElement("span");
  badgeEl.className = "result-place";
  badgeEl.textContent = place;
  li.append(badgeEl, text);
  return li;
}

/** Pick or unpick a card to play. Picking a different rank starts over. */
function toggleSelected(card) {
  const key = cardKey(card);
  if (state.selected.has(key)) {
    state.selected.delete(key);
  } else {
    const [first] = state.selected;
    if (first && first.slice(0, -1) !== card.rank) state.selected.clear();
    state.selected.add(key);
  }
  renderGame();
}

function playSelected() {
  const game = state.game;
  if (!game || state.selected.size === 0) return;
  const me = game.players.find((p) => p.id === game.you);
  const source = activeSource(game, me);
  if (source !== "hand" && source !== "upcards") return;

  const cards = [...state.selected].map((key) => ({ rank: key.slice(0, -1), suit: key.slice(-1) }));
  state.socket?.send({ type: "play", source, cards });
  state.selected.clear();
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

el.playBtn.addEventListener("click", playSelected);
el.pickupBtn.addEventListener("click", () => {
  state.selected.clear();
  state.socket?.send({ type: "pick-up" });
});

el.readyBtn.addEventListener("click", () => {
  const me = state.game?.players.find((p) => p.id === state.game.you);
  state.socket?.send({ type: "ready", ready: !me?.ready });
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
