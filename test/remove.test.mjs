/**
 * The host removing players who have gone away, over real sockets.
 *
 * Needs a dev server running:  npm run dev   (then, separately)  npm test
 * Point it at a deployment with:
 *   PARTY_HOST=shithead-multiplayer.<subdomain>.workers.dev npm test
 */

import { checker, roomName, seat } from "./harness.mjs";

const { check, report } = checker();

const room = roomName("remove");
const ann = await seat(room, "ann", "id-ann", "Ann");
const ben = await seat(room, "ben", "id-ben", "Ben");
const cat = await seat(room, "cat", "id-cat", "Cat");
await ann.waitFor(() => ann.last("room")?.players.length === 3, "all three seated");

ann.send({ type: "start-game" });
await Promise.all([ann, ben, cat].map((c) => c.waitForType("game")));

// --- a player who drops during the swap isn't waited on --------------------
ann.send({ type: "ready", ready: true });
ben.send({ type: "ready", ready: true });
await ben.waitFor(() => ben.last("game").players.filter((p) => p.ready).length === 2, "two ready");
check("two of three ready doesn't start play", ben.last("game").phase === "swap");

cat.ws.terminate();
await ann.waitFor(() => ann.last("game").phase === "playing", "play to begin without Cat");
check("the last unready player dropping starts play", ann.last("game").phase === "playing");

const seatOf = (c, id) => c.last("game").players.find((p) => p.id === id);
check("Cat shows as away", seatOf(ann, "id-cat").connected === false);

// --- who may remove whom ---------------------------------------------------
async function refusal(client, msg, what) {
  const n = client.all("error").length;
  client.send(msg);
  await client.waitFor(() => client.all("error").length > n, what);
  return client.last("error");
}

let err = await refusal(ben, { type: "remove-player", playerId: "id-cat" }, "a not-host refusal");
check("a non-host can't remove anyone", err.code === "not-host" && err.fatal === false);

err = await refusal(ann, { type: "remove-player", playerId: "id-ben" }, "a still-connected refusal");
check("the host can't remove someone still connected", err.code === "cant-remove");

err = await refusal(ann, { type: "remove-player", playerId: "id-nobody" }, "an unknown-player refusal");
check("or someone who isn't at the table", err.code === "cant-remove");

// --- removing Cat ----------------------------------------------------------
const wasCatsTurn = ann.last("game").currentPlayerId === "id-cat";
ann.send({ type: "remove-player", playerId: "id-cat" });
await Promise.all(
  [ann, ben].map((c) => c.waitFor(() => seatOf(c, "id-cat").removed === true, "Cat to be removed")),
);

const view = ben.last("game");
const catSeat = seatOf(ben, "id-cat");
check("everyone sees Cat removed", catSeat.removed && seatOf(ann, "id-cat").removed);
check("Cat's cards are out of play", catSeat.handCount + catSeat.upcards.length + catSeat.downcardCount === 0);
check("the table says so", view.lastEvent?.kind === "removed" && view.lastEvent.playerId === "id-cat");
check("and records the order", view.removedOrder.join() === "id-cat");
check("it's never Cat's turn now", view.currentPlayerId !== "id-cat");
if (wasCatsTurn) check("it was Cat's turn, so play moved on", view.currentPlayerId !== null);
check("the game carries on with two", view.phase === "playing");
const total =
  view.players.reduce((n, p) => n + p.handCount + p.upcards.length + p.downcardCount, 0) +
  view.deckCount + view.wasteCount + view.burnedCount;
check("no cards created or lost (Cat's went to the burned pile)", total === 52);

const catBack = await seat(room, "cat-again", "id-cat", "Cat");
await catBack.waitFor(() => catBack.closed, "Cat to be turned away");
check("a removed player can't come back", catBack.last("error")?.code === "removed" && catBack.last("error").fatal);
check("and never sees the table again", !catBack.last("game"));

// --- the host's powers pass on when the host drops ------------------------
check("Ann is host", ben.last("game").hostId === "id-ann");
ann.ws.terminate();
await ben.waitFor(() => ben.last("game").hostId === "id-ben", "Ben to become host");
check("with the host away, the next connected player is host", ben.last("game").hostId === "id-ben");

ben.send({ type: "remove-player", playerId: "id-ann" });
await ben.waitFor(() => ben.last("game").phase === "finished", "the game to end");
const end = ben.last("game");
check("removing down to one player ends the game", end.phase === "finished" && end.currentPlayerId === null);
check("the one left takes 1st", end.finishOrder.join() === "id-ben" && seatOf(ben, "id-ben").place === 1);
check("and nobody is named shithead", end.shitheadId === null);
check("removals are listed in order", end.removedOrder.join() === "id-cat,id-ann");

err = await refusal(ben, { type: "remove-player", playerId: "id-ann" }, "a refusal after the end");
check("no removals once the game is over", err.code === "wrong-phase");

report([ann, ben, cat, catBack]);
