/**
 * Deal + hidden-information tests for the room server (milestone 2).
 *
 * Needs a dev server running:  npm run dev   (then, separately)  npm test
 * Point it at a deployment with:
 *   PARTY_HOST=shithead-multiplayer.<subdomain>.workers.dev npm test
 *
 * The leak assertions are the point of this file: the whole reason the
 * server is authoritative is that a client can never obtain a card it isn't
 * entitled to see.
 */

import { cardKey, checker, roomName, seat } from "./harness.mjs";

const { check, report } = checker();

/** Every card object anywhere in a message, however deeply nested. */
function cardsIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const v of value) cardsIn(v, found);
  } else if (value && typeof value === "object") {
    if (typeof value.rank === "string" && typeof value.suit === "string") {
      found.push(`${value.rank}${value.suit}`);
    }
    for (const v of Object.values(value)) cardsIn(v, found);
  }
  return found;
}

// ---------------------------------------------------------------------------
// A dealt 3-player game
// ---------------------------------------------------------------------------

const room = roomName("deal");
const alice = await seat(room, "alice", "id-alice", "Alice");
const bob = await seat(room, "bob", "id-bob", "Bob");
const carol = await seat(room, "carol", "id-carol", "Carol");
await alice.waitFor(() => alice.last("room")?.players.length === 3, "all three seated");

// --- only the host can start, and only with enough players ---------------
bob.send({ type: "start-game" });
await bob.waitForType("error");
check("a non-host can't start the game", bob.last("error")?.code === "not-host");
check("being refused the start doesn't kick you out", !bob.closed);
check("a refused start is marked non-fatal", bob.last("error")?.fatal === false);
check("no game state was sent", !bob.last("game"));

alice.send({ type: "start-game" });
await Promise.all([
  alice.waitForType("game"),
  bob.waitForType("game"),
  carol.waitForType("game"),
]);

const game = alice.last("game");
check("host can start the game", !!game);
check("phase moves to swap", game?.phase === "swap");
check("every seat is present in the view", game?.players.length === 3);

// --- the deal ------------------------------------------------------------
check("dealt 3 hand cards", game?.hand.length === 3);
check(
  "every seat shows 3 up-cards",
  game?.players.every((p) => p.upcards.length === 3),
);
check(
  "every seat shows 3 hand cards and 3 down-cards, as counts",
  game?.players.every((p) => p.handCount === 3 && p.downcardCount === 3),
);
check("draw pile holds the rest of the deck", game?.deckCount === 52 - 3 * 9);
check("waste pile starts empty", game?.wasteCount === 0 && game?.wasteTop === null);
check("nothing is burned yet", game?.burnedCount === 0);
check(
  "cards carry rank, suit and value",
  game?.hand.every(
    (c) => typeof c.rank === "string" && typeof c.suit === "string" && c.value >= 2 && c.value <= 14,
  ),
);

// --- each player got a different hand, and every card is distinct --------
const hands = [alice, bob, carol].map((c) => c.last("game")?.hand ?? []);
check("all three players received a hand", hands.every((h) => h.length === 3));
const allDealt = [
  ...hands.flat(),
  ...(game?.players.flatMap((p) => p.upcards) ?? []),
].map(cardKey);
check(
  "no card was dealt to two places at once",
  new Set(allDealt).size === allDealt.length,
);

// --- THE LEAK TESTS -------------------------------------------------------
const aliceSaw = cardsIn(alice.msgs);
const aliceEntitled = new Set([
  ...(alice.last("game")?.hand ?? []).map(cardKey),
  ...(game?.players.flatMap((p) => p.upcards) ?? []).map(cardKey),
]);
check(
  "a player only ever receives their own hand plus public up-cards",
  aliceSaw.every((card) => aliceEntitled.has(card)),
);

const bobsHand = new Set((bob.last("game")?.hand ?? []).map(cardKey));
check(
  "one player's hand never appears in another's messages",
  !cardsIn(alice.msgs).some((card) => bobsHand.has(card)),
);
check(
  "nobody's messages contain a downcards field at all",
  !JSON.stringify(alice.msgs).includes("downcards"),
);
check(
  "a seat view never carries a `hand` array, only a count",
  (game?.players ?? []).every((p) => p.hand === undefined && p.handCount === 3),
);
check(
  "the deck is never sent, only its size",
  !JSON.stringify(alice.msgs).includes('"deck"'),
);
// 52 cards exist; one player may legitimately see 3 (own hand) + 9 (all
// up-cards) = 12 distinct cards, and no more.
check(
  "a player can see at most their hand and every up-card",
  new Set(aliceSaw).size <= 12,
);

// --- joining a game in progress ------------------------------------------
const dave = await seat(room, "dave", "id-dave", "Dave");
await dave.waitFor(() => dave.closed, "the newcomer to be dropped");
check("a newcomer can't join a game in progress", dave.last("error")?.code === "game-in-progress");
check("that refusal is fatal", dave.last("error")?.fatal === true);
check("the newcomer is dropped", dave.closed);
check("and never sees the table", !dave.last("game"));

// --- a reconnect mid-game keeps the seat and the same cards --------------
const aliceHandBefore = JSON.stringify(alice.last("game")?.hand);
alice.ws.terminate();
await bob.waitFor(
  () => bob.last("game")?.players.find((p) => p.id === "id-alice")?.connected === false,
  "Alice to show as away",
);
check(
  "a mid-game drop keeps the seat, marked away",
  bob.last("game")?.players.find((p) => p.id === "id-alice")?.connected === false,
);
check("the seat is not removed mid-game", bob.last("game")?.players.length === 3);

const aliceBack = await seat(room, "alice-again", "id-alice", "Alice");
await aliceBack.waitForType("game");
check("reconnecting returns the same hand", JSON.stringify(aliceBack.last("game")?.hand) === aliceHandBefore);
check(
  "and the seat is marked back",
  aliceBack.last("game")?.players.find((p) => p.id === "id-alice")?.connected === true,
);
check("reconnecting player lands in the game, not the lobby", aliceBack.last("game")?.phase === "swap");

report([alice, bob, carol, dave, aliceBack]);
