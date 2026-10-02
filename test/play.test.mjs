/**
 * Play tests over real sockets (milestone 3).
 *
 * Needs a dev server running:  npm run dev   (then, separately)  npm test
 * Point it at a deployment with:
 *   PARTY_HOST=shithead-multiplayer.<subdomain>.workers.dev npm test
 *
 * The rules themselves are pinned down deterministically in
 * `rules.test.mjs`. Deals here are random, so this file instead plays whole
 * games to the end with a simple bot on every seat, and after *every* move
 * checks the things that must always hold: no card created or lost, nobody
 * holding a card someone else holds, and no message carrying a card its
 * recipient isn't entitled to see. A blind down-card play is the first time
 * a hidden card becomes public, so it's the likeliest place for a leak.
 */

import { cardKey as key, checker, roomName, seat } from "./harness.mjs";

const { check, report } = checker();

/**
 * A bot game that runs this long has stalled rather than broken. With
 * mechanical play, the rules as ported can loop forever on forced moves —
 * e.g. one player stuck on up-cards that can't beat an 8 picks it up, plays
 * it back, and round it goes — about 1 game in 900 in simulation. Humans
 * break such loops; the bot can't, so a stalled game is re-dealt instead.
 */
const MAX_MOVES = 1500;
const ATTEMPTS = 3;

// --- the rules, as a client sees them (the server's are authoritative) ----

const SPECIAL = new Set(["2", "7", "8", "10"]);
function canPlay(card, top) {
  if (!top) return true;
  if (card.rank === "2" || card.rank === "8" || card.rank === "10") return true;
  if (top.rank === "7") return card.value <= 7 || SPECIAL.has(card.rank);
  if (card.rank === "7") return top.value <= 7;
  if (top.rank === "2") return true;
  return card.value >= top.value;
}

/**
 * Usually the lowest legal rank (all copies of it), sometimes another legal
 * rank, so bots don't lock into the same cycle; otherwise pick up.
 */
function botMove(view) {
  const me = view.players.find((p) => p.id === view.you);
  if (view.hand.length === 0 && me.upcards.length === 0) {
    return { type: "play-blind", index: 0 };
  }
  const source = view.hand.length > 0 ? "hand" : "upcards";
  const pool = source === "hand" ? view.hand : me.upcards;
  const legal = pool.filter((c) => canPlay(c, view.wasteTop)).sort((a, b) => a.value - b.value);
  if (legal.length === 0) return { type: "pick-up" };
  const rank = (Math.random() < 0.25 ? legal[Math.floor(Math.random() * legal.length)] : legal[0]).rank;
  return {
    type: "play",
    source,
    cards: pool.filter((c) => c.rank === rank).map(({ rank, suit }) => ({ rank, suit })),
  };
}

// --- invariants ------------------------------------------------------------

/** Every card in a message, with the path it was found at. */
function cardsWithPaths(value, path = "", found = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => cardsWithPaths(v, `${path}[${i}]`, found));
  } else if (value && typeof value === "object") {
    if (typeof value.rank === "string" && typeof value.suit === "string") {
      found.push({ card: key(value), path });
    }
    for (const [k, v] of Object.entries(value)) cardsWithPaths(v, `${path}.${k}`, found);
  }
  return found;
}

/**
 * The only places a card may legitimately appear in a game message: the
 * recipient's own hand, anyone's face-up cards, the visible top of the
 * pile, and the card(s) the last move played or revealed.
 */
const ENTITLED = /^\.(hand\[\d+\]|players\[\d+\]\.upcards\[\d+\]|wasteTop|wasteRecent\[\d+\]|lastEvent\.cards\[\d+\])$/;

const problems = new Map();
const note = (what, detail) => {
  if (!problems.has(what)) problems.set(what, detail);
};

function checkInvariants(clients) {
  const views = clients.map((c) => c.last("game"));

  for (const [i, view] of views.entries()) {
    for (const { card, path } of cardsWithPaths(view)) {
      if (!ENTITLED.test(path)) note("a card appeared where it shouldn't", `${clients[i].label}: ${card} at ${path}`);
    }
    if (JSON.stringify(view).includes("downcards")) note("a downcards field went on the wire", clients[i].label);

    const total =
      view.players.reduce((n, p) => n + p.handCount + p.upcards.length + p.downcardCount, 0) +
      view.deckCount + view.wasteCount + view.burnedCount;
    if (total !== 52) note("cards were created or lost", `${clients[i].label} counts ${total}`);

    const me = view.players.find((p) => p.id === view.you);
    if (me.handCount !== view.hand.length) note("own hand disagrees with its public count", clients[i].label);
  }

  // Everyone's own hand plus every public card: all distinct, all different.
  const placed = [
    ...views.flatMap((v) => v.hand.map(key)),
    ...views[0].players.flatMap((p) => p.upcards.map(key)),
    ...views[0].wasteRecent.map(key),
  ];
  if (new Set(placed).size !== placed.length) note("one card was in two places at once", placed.join(" "));

  // All clients agree on the public state.
  const publicOf = (v) => JSON.stringify({ ...v, you: null, hand: null });
  if (!views.every((v) => publicOf(v) === publicOf(views[0]))) note("clients disagree about the table", "");
}

// --- a whole game ----------------------------------------------------------

async function playWholeGame(names, attempt = 1) {
  const room = roomName(`play${names.length}`);
  const clients = [];
  for (const name of names) clients.push(await seat(room, name, `id-${name}`, name));
  const [host] = clients;
  await host.waitFor(() => host.last("room")?.players.length === names.length, "everyone seated");

  host.send({ type: "start-game" });
  await Promise.all(clients.map((c) => c.waitForType("game")));

  // Playing during the swap phase is refused.
  host.send({ type: "pick-up" });
  await host.waitForType("error");
  check(`${names.length}p: moves are refused during the swap phase`, host.last("error").code === "wrong-phase");

  for (const c of clients) c.send({ type: "ready", ready: true });
  await Promise.all(clients.map((c) => c.waitFor(() => c.last("game").phase === "playing", "play to begin")));

  const byId = (id) => clients.find((c) => c.last("game").you === id);
  const leader = byId(host.last("game").currentPlayerId);
  const bystander = clients.find((c) => c !== leader);

  // Out of turn, and an empty pile pick-up: both refused, nothing changes.
  const errorsBefore = bystander.all("error").length;
  bystander.send(botMove(bystander.last("game")));
  await bystander.waitFor(() => bystander.all("error").length > errorsBefore, "an out-of-turn refusal");
  check(`${names.length}p: playing out of turn is refused`, bystander.last("error").code === "not-your-turn");

  leader.send({ type: "pick-up" });
  await leader.waitFor(() => leader.last("error")?.code === "nothing-to-pick-up", "an empty pick-up refusal");
  check(`${names.length}p: picking up an empty pile is refused`, leader.last("error").code === "nothing-to-pick-up");

  const notHeld = { rank: "A", suit: "♠" };
  const holdsIt = leader.last("game").hand.some((c) => key(c) === "A♠");
  if (!holdsIt) {
    const n = leader.all("error").length;
    leader.send({ type: "play", source: "hand", cards: [notHeld] });
    await leader.waitFor(() => leader.all("error").length > n, "a not-held refusal");
    check(`${names.length}p: playing a card you don't hold is refused`, leader.last("error").code === "bad-card");
  }

  {
    const n = host.all("error").length;
    host.send({ type: "play-again" });
    await host.waitFor(() => host.all("error").length > n, "a play-again refusal mid-game");
    check(`${names.length}p: play again is refused mid-game`, host.last("error").code === "wrong-phase");
  }

  checkInvariants(clients);

  const kinds = new Set();
  let moves = 0;
  while (host.last("game").phase === "playing" && moves < MAX_MOVES) {
    const current = byId(host.last("game").currentPlayerId);
    const counts = clients.map((c) => c.all("game").length);
    const errors = current.all("error").length;

    current.send(botMove(current.last("game")));
    await current.waitFor(
      () => current.all("error").length > errors || current.all("game").length > counts[clients.indexOf(current)],
      "the move to be answered",
    );
    if (current.all("error").length > errors) {
      note("the server refused a move the bot thought was legal", current.last("error").message);
      break;
    }
    await Promise.all(clients.map((c, i) => c.waitFor(() => c.all("game").length > counts[i], "the move to reach everyone")));

    const event = host.last("game").lastEvent;
    kinds.add(event.kind);
    if (event.reversed) kinds.add("(reversed)");
    if (event.burned) kinds.add("(burned)");
    checkInvariants(clients);
    moves += 1;
  }

  const end = host.last("game");
  const label = `${names.length}p`;
  if (end.phase === "playing" && moves >= MAX_MOVES && attempt < ATTEMPTS) {
    console.log(`(${label}: stalled after ${moves} moves on attempt ${attempt}, re-dealing)`);
    for (const c of clients) c.ws.close();
    return playWholeGame(names, attempt + 1);
  }

  check(`${label}: the game reaches the end (${moves} moves)`, end.phase === "finished");
  check(`${label}: everyone but one has a finishing place`, end.finishOrder.length === names.length - 1);
  check(`${label}: places are 1st, 2nd, ... in finishing order`, end.finishOrder.every((id, i) => end.players.find((p) => p.id === id).place === i + 1));
  const loser = end.players.find((p) => p.place === null);
  check(`${label}: the one left holding cards is the shithead`, loser && end.shitheadId === loser.id && loser.handCount + loser.upcards.length + loser.downcardCount > 0);
  check(`${label}: nobody's turn once it's over`, end.currentPlayerId === null);
  check(`${label}: some moves were plays and some were pick-ups`, kinds.has("play") && kinds.has("pick-up"));

  const n = host.all("error").length;
  host.send({ type: "pick-up" });
  await host.waitFor(() => host.all("error").length > n, "a refusal after the end");
  check(`${label}: no moves once the game is over`, host.last("error").code === "wrong-phase");

  return { clients, kinds };
}

const two = await playWholeGame(["ann", "ben"]);
const three = await playWholeGame(["cat", "dan", "eve"]);
const four = await playWholeGame(["fay", "gus", "hal", "ivy"]);

// --- play again, after the 3-player game -----------------------------------
{
  const [cat, dan, eve] = three.clients;
  const n = dan.all("error").length;
  dan.send({ type: "play-again" });
  await dan.waitFor(() => dan.all("error").length > n, "a not-host refusal");
  check("play again: only the host can", dan.last("error").code === "not-host");

  // Eve goes away first, so she should be dropped from the next game.
  eve.ws.terminate();
  await cat.waitFor(
    () => cat.last("game").players.find((p) => p.id === "id-eve").connected === false,
    "Eve to show as away",
  );

  const rooms = [cat, dan].map((c) => c.all("room").length);
  cat.send({ type: "play-again" });
  await Promise.all([cat, dan].map((c, i) => c.waitFor(() => c.all("room").length > rooms[i], "the lobby")));

  const lobby = dan.last("room");
  check("play again: everyone goes back to the room", lobby.phase === "lobby" && cat.last("room").phase === "lobby");
  check("play again: connected players keep their seats, in order", lobby.players.map((p) => `${p.seat}:${p.id}`).join() === "0:id-cat,1:id-dan");
  check("play again: the away player is dropped", !lobby.players.some((p) => p.id === "id-eve"));
  check("play again: the host is still the host", lobby.hostId === "id-cat");

  const eveBack = await seat(lobby.code.toLowerCase(), "eve-again", "id-eve", "eve");
  await cat.waitFor(() => cat.last("room").players.length === 3, "Eve to rejoin the lobby");
  check("play again: the dropped player can join the new game", cat.last("room").players.at(-1).id === "id-eve");

  cat.send({ type: "start-game" });
  await Promise.all([cat, dan, eveBack].map((c) => c.waitFor(() => c.last("game")?.phase === "swap", "a fresh deal")));
  const fresh = cat.last("game");
  check("play again: a fresh deal", fresh.players.every((p) => p.handCount === 3 && p.upcards.length === 3 && p.downcardCount === 3 && p.place === null && !p.removed));
  check("play again: the table is reset", fresh.deckCount === 52 - 27 && fresh.wasteCount === 0 && fresh.burnedCount === 0 && fresh.finishOrder.length === 0 && fresh.lastEvent === null && fresh.shitheadId === null);
  three.clients.push(eveBack);
}

const allKinds = new Set([...two.kinds, ...three.kinds, ...four.kinds]);
console.log(`(move kinds seen: ${[...allKinds].join(", ")})`);

for (const [what, detail] of problems) check(`${what}: ${detail}`, false);
check("after every move: cards conserved, hands disjoint, no leaks, clients agree", problems.size === 0);

report([...two.clients, ...three.clients, ...four.clients]);
