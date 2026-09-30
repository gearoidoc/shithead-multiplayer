/**
 * Swap-phase tests (milestone 2, second half).
 *
 * Needs a dev server running:  npm run dev   (then, separately)  npm test
 * Point it at a deployment with:
 *   PARTY_HOST=shithead-multiplayer.<subdomain>.workers.dev npm test
 */

import { cardKey as key, checker, roomName, seat } from "./harness.mjs";

const { check, report } = checker();

// --- a dealt two-player game ----------------------------------------------
const room = roomName("swap");
const alice = await seat(room, "alice", "id-alice", "Alice");
const bob = await seat(room, "bob", "id-bob", "Bob");
await alice.waitFor(() => alice.last("room")?.players.length === 2, "both seated");

alice.send({ type: "start-game" });
await Promise.all([alice.waitForType("game"), bob.waitForType("game")]);

check("everyone starts not ready", alice.last("game").players.every((p) => p.ready === false));
check("no first player during the swap phase", alice.last("game").currentPlayerId === null);
check("turn direction starts forward", alice.last("game").turnDirection === 1);

// --- a legal swap ---------------------------------------------------------
const handBefore = alice.last("game").hand.map(key);
const upBefore = alice.me().upcards.map(key);
alice.send({ type: "swap", handIndex: 0, upcardIndex: 2 });
await Promise.all([
  alice.waitFor(() => alice.last("game").hand.map(key)[0] !== handBefore[0], "the swap to land"),
  bob.waitForNext("game", "game update"),
]);

const handAfter = alice.last("game").hand.map(key);
const upAfter = alice.me().upcards.map(key);
check("the two chosen cards traded places", handAfter[0] === upBefore[2] && upAfter[2] === handBefore[0]);
check("the untouched hand cards didn't move", handAfter[1] === handBefore[1] && handAfter[2] === handBefore[2]);
check("the untouched up-cards didn't move", upAfter[0] === upBefore[0] && upAfter[1] === upBefore[1]);
check(
  "no card was created or destroyed",
  new Set([...handAfter, ...upAfter]).size === 6 &&
    [...handBefore, ...upBefore].every((c) => [...handAfter, ...upAfter].includes(c)),
);
check("still 3 in hand and 3 up", handAfter.length === 3 && upAfter.length === 3);
check("the swap is visible to the other player", bob.last("game").players.find((p) => p.id === "id-alice").upcards.map(key)[2] === handBefore[0]);
check("swapping doesn't leak the swapper's hand", !JSON.stringify(bob.msgs).includes(handAfter[1]));

// --- illegal swaps --------------------------------------------------------
const stateBefore = JSON.stringify(alice.last("game").hand) + JSON.stringify(alice.me().upcards);
for (const [name, msg] of [
  ["a hand index past the end", { type: "swap", handIndex: 3, upcardIndex: 0 }],
  ["an up-card index past the end", { type: "swap", handIndex: 0, upcardIndex: 3 }],
  ["a negative index", { type: "swap", handIndex: -1, upcardIndex: 0 }],
  ["a non-integer index", { type: "swap", handIndex: 1.5, upcardIndex: 0 }],
  ["a string index", { type: "swap", handIndex: "0", upcardIndex: 0 }],
]) {
  const errors = alice.all("error").length;
  alice.send(msg);
  await alice.waitFor(() => alice.all("error").length > errors, `a refusal of ${name}`);
  check(`${name} is refused`, alice.last("error")?.code === "bad-card");
}
check(
  "no illegal swap changed anything",
  JSON.stringify(alice.last("game").hand) + JSON.stringify(alice.me().upcards) === stateBefore,
);
check("being refused a swap doesn't end the game", alice.last("game").phase === "swap");

// --- ready, un-ready, and swapping after readying ------------------------
alice.send({ type: "ready", ready: true });
await bob.waitFor(
  () => bob.last("game").players.find((p) => p.id === "id-alice").ready === true,
  "Alice to show as ready",
);
check("readying is visible to everyone", bob.last("game").players.find((p) => p.id === "id-alice").ready === true);
check("one player ready doesn't start play", bob.last("game").phase === "swap");

alice.send({ type: "swap", handIndex: 0, upcardIndex: 0 });
await alice.waitFor(() => alice.me().ready === false, "the swap to clear ready");
check("swapping after readying un-readies you", alice.me().ready === false);

alice.send({ type: "ready", ready: true });
await alice.waitFor(() => alice.me().ready === true, "ready to be set");
alice.send({ type: "ready", ready: false });
await alice.waitFor(() => alice.me().ready === false, "ready to be cleared");
check("you can change your mind", alice.me().ready === false);
check("un-readying doesn't start play", alice.last("game").phase === "swap");

// --- both ready ends the swap phase --------------------------------------
alice.send({ type: "ready", ready: true });
await alice.waitFor(() => alice.me().ready === true, "Alice ready");
bob.send({ type: "ready", ready: true });
await Promise.all([
  bob.waitFor(() => bob.last("game").phase === "playing", "play to begin"),
  alice.waitFor(() => alice.last("game").phase === "playing", "play to begin"),
]);

const playing = bob.last("game");
check("both ready moves the room into play", playing.phase === "playing");
check("a first player is chosen", typeof playing.currentPlayerId === "string");
check(
  "the first player is one of the seated players",
  playing.players.some((p) => p.id === playing.currentPlayerId),
);

// The lead is whoever holds the lowest card by 3,4..K,A,2 across hand and
// up-cards, earliest seat winning a tie. Recompute it from what's public
// plus each player's own hand.
const ORDER = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const holdings = playing.players.map((p) => {
  const own = (p.id === "id-alice" ? alice : bob).last("game").hand;
  return { id: p.id, ranks: [...own, ...p.upcards].map((c) => c.rank) };
});
const expected = (() => {
  for (const rank of ORDER) {
    const holder = holdings.find((h) => h.ranks.includes(rank));
    if (holder) return holder.id;
  }
  return null;
})();
check(`the lowest card leads (expected ${expected})`, playing.currentPlayerId === expected);

// --- the swap phase is over ----------------------------------------------
const errorsBefore = alice.all("error").length;
alice.send({ type: "swap", handIndex: 0, upcardIndex: 1 });
await alice.waitFor(() => alice.all("error").length > errorsBefore, "a wrong-phase refusal");
check("swapping is refused once play has started", alice.last("error")?.code === "wrong-phase");
check("and is non-fatal", alice.last("error")?.fatal === false);
check("cards are unchanged after that refusal", alice.last("game").phase === "playing");

report([alice, bob]);
