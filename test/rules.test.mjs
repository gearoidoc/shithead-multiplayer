/**
 * Rules engine tests (milestone 3). Pure: no dev server needed.
 *
 * Node 22.18+ / 24 strips TypeScript types natively, so this imports
 * `src/rules.ts` directly — no build step, matching the rest of the project.
 *
 * `canPlayCard` is also checked against the single-player game's own
 * implementation, loaded straight out of
 * `../gearoidoc.github.io/shithead/game.js` when that repo is checked out
 * alongside this one.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checker } from "./harness.mjs";
import {
  applyMove,
  canPlayCard,
  determineFirstPlayer,
  emptyTable,
  isGameOver,
  nextPlayerId,
  shitheadId,
} from "../src/rules.ts";
import { RANKS, VALUES } from "../src/shared/cards.ts";

const { check, report } = checker();

// --- helpers ---------------------------------------------------------------

/** "10♥" -> { rank: "10", suit: "♥", value: 10 } */
const c = (text) => {
  const rank = text.slice(0, -1);
  return { rank, suit: text.slice(-1), value: VALUES[rank] };
};
const cs = (text) => (text ? text.split(" ").map(c) : []);
const id = ({ rank, suit }) => ({ rank, suit });
const show = (cards) => cards.map((x) => x.rank + x.suit).join(" ");

/**
 * Build a table from a terse description. Seats are { id, hand, up, down }
 * with cards as space-separated strings.
 */
function table({ seats, waste = "", deck = "", current, direction = 1, finished = [] }) {
  const t = emptyTable(
    seats.map((s) => ({ id: s.id, hand: cs(s.hand), upcards: cs(s.up), downcards: cs(s.down) })),
  );
  t.wastePile = cs(waste);
  t.deck = cs(deck);
  t.currentPlayerId = current ?? seats[0].id;
  t.turnDirection = direction;
  t.finishOrder = [...finished];
  return t;
}

const seatOf = (t, who) => t.seats.find((s) => s.id === who);
const play = (t, who, cards, source = "hand") =>
  applyMove(t, who, { kind: "play", source, cards: cs(cards).map(id) });

const ABCD = (extra = {}) =>
  ["A", "B", "C", "D"].map((who) => ({ id: who, hand: "3♣ 4♣ 5♣", up: "6♣", down: "9♣", ...extra[who] }));

// --- canPlayCard, against the single-player original ---------------------

const reference = fileURLToPath(
  new URL("../../gearoidoc.github.io/shithead/game.js", import.meta.url),
);

/** Pull one top-level function's source out of game.js by brace counting. */
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no ${name} in game.js`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

if (existsSync(reference)) {
  const source = readFileSync(reference, "utf8");
  const body = ["getTopCard", "isUnder7Rule", "isSpecialRank", "canPlayCard"]
    .map((name) => extract(source, name))
    .join("\n");
  // The originals read a global `gameState`; hand them one.
  const original = new Function("gameState", `${body}\nreturn canPlayCard;`);

  const mismatches = [];
  for (const topRank of [null, ...RANKS]) {
    const top = topRank && { rank: topRank, suit: "♠", value: VALUES[topRank] };
    const canPlay = original({ wastePile: top ? [top] : [] });
    for (const rank of RANKS) {
      const card = { rank, suit: "♥", value: VALUES[rank] };
      if (canPlay(card) !== canPlayCard(card, top)) mismatches.push(`${rank} on ${topRank}`);
    }
  }
  check(
    `canPlayCard agrees with the single-player game on all 182 pairs${mismatches.length ? ` (differs: ${mismatches.join(", ")})` : ""}`,
    mismatches.length === 0,
  );
} else {
  console.log(`(skipping the single-player cross-check: ${reference} not found)`);
}

// Spot checks, so the intent is written down and not only inherited.
const on = (card, top) => canPlayCard(c(card), top ? c(top) : null);
check("anything goes on an empty pile", on("3♠", null) && on("A♠", null));
check("equal or higher goes on a normal card", on("9♠", "9♥") && on("K♠", "9♥") && !on("5♥", "9♥"));
check("2, 8 and 10 go on anything", ["2♠", "8♠", "10♠"].every((x) => on(x, "A♥")));
check("anything goes on a 2", on("3♠", "2♥") && on("A♠", "2♥"));
check("on a 7, only 7-or-lower or specials", on("4♠", "7♥") && on("7♠", "7♥") && !on("9♠", "7♥") && !on("A♠", "7♥") && on("10♠", "7♥"));
check("a 7 only goes on 7-or-lower", on("7♠", "5♥") && !on("7♠", "9♥"));

// --- moves, validation -------------------------------------------------------

{
  const t = table({ seats: [{ id: "A", hand: "5♠ 9♠ 9♥", up: "K♠" }, { id: "B", hand: "3♦" }], waste: "6♣" });
  const before = JSON.stringify(t);
  const refused = (label, result, code) => check(`${label} is refused (${code})`, !result.ok && result.code === code);

  refused("playing out of turn", play(t, "B", "3♦"), "not-your-turn");
  refused("a card below the pile", play(t, "A", "5♠"), "illegal-play");
  refused("mixed ranks", play(t, "A", "9♠ 5♠"), "illegal-play");
  refused("a card you don't hold", play(t, "A", "9♦"), "bad-card");
  refused("the same card named twice", play(t, "A", "9♠ 9♠"), "bad-card");
  refused("an empty play", play(t, "A", ""), "bad-card");
  refused("up-cards while holding a hand", play(t, "A", "K♠", "upcards"), "wrong-source");
  refused("down-cards while holding a hand", applyMove(t, "A", { kind: "play-blind", index: 0 }), "wrong-source");
  refused("a made-up source", applyMove(t, "A", { kind: "play", source: "deck", cards: [] }), "wrong-source");
  refused("junk card ids", applyMove(t, "A", { kind: "play", source: "hand", cards: [{ rank: "1", suit: "x" }] }), "bad-card");
  refused("a non-array of cards", applyMove(t, "A", { kind: "play", source: "hand", cards: "9♠" }), "bad-card");
  refused("an unknown move", applyMove(t, "A", { kind: "cheat" }), "bad-card");
  check("no refused move changed the table", JSON.stringify(t) === before);

  const ok = play(t, "A", "9♠ 9♥");
  check("two of a rank play together", ok.ok && show(t.wastePile) === "6♣ 9♠ 9♥");
  check("they leave the hand", show(seatOf(t, "A").hand) === "5♠");
  check("and the turn passes", t.currentPlayerId === "B");
  check("the event says what happened", ok.event.kind === "play" && show(ok.event.cards) === "9♠ 9♥" && !ok.event.goAgain);
}

{
  const t = table({ seats: [{ id: "A", hand: "", up: "Q♠ 4♦" }, { id: "B", hand: "3♦" }], waste: "J♣" });
  check("hand empty: up-cards are playable", play(t, "A", "Q♠", "upcards").ok && show(seatOf(t, "A").upcards) === "4♦");
}

// --- drawing back up -------------------------------------------------------

{
  const t = table({ seats: [{ id: "A", hand: "5♠ 9♠ 9♥" }, { id: "B", hand: "3♦" }], deck: "2♣ 3♣ 4♣" });
  play(t, "A", "9♠ 9♥");
  check("the hand is topped back up to three from the deck", show(seatOf(t, "A").hand) === "5♠ 2♣ 3♣" && show(t.deck) === "4♣");
}
{
  const t = table({ seats: [{ id: "A", hand: "5♠ 9♠", up: "K♠" }, { id: "B", hand: "3♦" }], deck: "" });
  play(t, "A", "9♠");
  check("no drawing once the deck is empty", show(seatOf(t, "A").hand) === "5♠");
}

// --- special cards ---------------------------------------------------------

{
  const t = table({ seats: [{ id: "A", hand: "10♠ 4♠", up: "K♠" }, { id: "B", hand: "3♦" }], waste: "A♣ K♣" });
  const r = play(t, "A", "10♠");
  check("a 10 burns the pile", t.wastePile.length === 0 && show(t.burned) === "A♣ K♣ 10♠");
  check("and the same player goes again", t.currentPlayerId === "A" && r.event.burned && r.event.goAgain);
}
{
  const t = table({ seats: [{ id: "A", hand: "6♠ 6♥ 3♠", up: "K♠" }, { id: "B", hand: "3♦" }], waste: "4♣ 6♣ 6♦" });
  const r = play(t, "A", "6♠ 6♥");
  check("four of a kind across turns burns the pile", r.event.burned && t.wastePile.length === 0 && t.burned.length === 5);
  check("and the same player goes again", t.currentPlayerId === "A");
}
{
  const t = table({ seats: [{ id: "A", hand: "J♠ J♥ J♦ J♣ 3♠", up: "K♠" }, { id: "B", hand: "3♦" }], waste: "5♣" });
  play(t, "A", "J♠ J♥ J♦ J♣");
  check("four of a kind in one play burns too", t.wastePile.length === 0 && t.currentPlayerId === "A");
}
{
  const t = table({ seats: [{ id: "A", hand: "8♠ 8♥ 3♠", up: "K♠" }, { id: "B", hand: "3♦" }], waste: "Q♣" });
  const r = play(t, "A", "8♠ 8♥");
  check("2 players: two 8s, same player goes again", r.event.goAgain && t.currentPlayerId === "A");
}
{
  const t = table({ seats: [{ id: "A", hand: "8♠ 3♠", up: "K♠" }, { id: "B", hand: "3♦" }], waste: "Q♣" });
  const r = play(t, "A", "8♠");
  check("2 players: a single 8 just passes the turn", t.currentPlayerId === "B" && !r.event.reversed && t.turnDirection === 1);
}
{
  const t = table({ seats: [{ id: "A", hand: "2♠ 3♠", up: "K♠" }, { id: "B", hand: "3♦" }], waste: "A♣" });
  play(t, "A", "2♠");
  check("a 2 goes on an ace and passes the turn", t.currentPlayerId === "B" && t.wastePile.at(-1).rank === "2");
}

// --- the 8 rule with 3-4 players (CLAUDE.md's worked example) --------------

{
  const t = table({ seats: ABCD({ A: { hand: "8♠ 3♠" }, D: { hand: "9♦ 3♦" } }), waste: "Q♣" });
  const r = play(t, "A", "8♠");
  check("4 players: A's single 8 reverses direction", t.turnDirection === -1 && r.event.reversed);
  check("and D plays next", t.currentPlayerId === "D");
  play(t, "D", "9♦");
  check("play then carries on in the new direction (D -> C)", t.currentPlayerId === "C");
}
{
  const t = table({ seats: ABCD({ A: { hand: "8♠ 8♥ 9♠" } }), waste: "Q♣" });
  const r = play(t, "A", "8♠ 8♥");
  check("4 players: A's two 8s, A goes again", t.currentPlayerId === "A" && r.event.goAgain);
  check("and direction does not change", t.turnDirection === 1 && !r.event.reversed);
  play(t, "A", "9♠");
  check("after A's extra turn, B is next (not D)", t.currentPlayerId === "B");
}
{
  const t = table({ seats: ABCD({ A: { hand: "8♠ 8♥ 8♦ 3♠" } }), waste: "Q♣" });
  const r = play(t, "A", "8♠ 8♥ 8♦");
  check("three 8s neither reverses nor goes again (assumed, see rules.ts)", t.currentPlayerId === "B" && !r.event.reversed && !r.event.goAgain);
}
{
  const t = table({ seats: ABCD({ C: { hand: "8♠ 3♠" } }), waste: "Q♣", current: "C", direction: -1 });
  play(t, "C", "8♠");
  check("a second single 8 reverses it back", t.turnDirection === 1 && t.currentPlayerId === "D");
}
{
  const t = table({ seats: ABCD({ A: { hand: "8♠ 3♠" } }), waste: "8♣ 8♦ 8♥" });
  const r = play(t, "A", "8♠");
  check("a single 8 that makes four of a kind burns instead of reversing", r.event.burned && !r.event.reversed && t.turnDirection === 1 && t.currentPlayerId === "A");
}
{
  const t = table({ seats: ABCD({ A: { hand: "8♠ 3♠" } }), waste: "Q♣", finished: ["C", "D"] });
  const r = play(t, "A", "8♠");
  check("with only two still playing, a single 8 doesn't reverse", !r.event.reversed && t.currentPlayerId === "B");
}

// --- turn order closes over finished seats ---------------------------------

{
  const t = table({ seats: ABCD(), finished: ["B"] });
  check("next after A skips a finished B", nextPlayerId(t, "A") === "C");
  t.turnDirection = -1;
  check("and skips it going the other way too", nextPlayerId(t, "C") === "A");
  check("and wraps round the table", nextPlayerId(t, "A") === "D");
}

// --- picking up ------------------------------------------------------------

{
  const t = table({ seats: [{ id: "A", hand: "3♠" }, { id: "B", hand: "3♦" }] });
  const r = applyMove(t, "A", { kind: "pick-up" });
  check("picking up an empty pile is refused", !r.ok && r.code === "nothing-to-pick-up" && t.currentPlayerId === "A");
}
{
  const t = table({ seats: [{ id: "A", hand: "3♠" }, { id: "B", hand: "3♦" }], waste: "9♣ J♥" });
  const r = applyMove(t, "A", { kind: "pick-up" });
  check("picking up takes the whole pile", show(seatOf(t, "A").hand) === "3♠ 9♣ J♥" && t.wastePile.length === 0);
  check("and passes the turn", t.currentPlayerId === "B" && r.event.pickedUp === 2);
  check("even with a legal play available (it's allowed)", r.ok);
}

// --- blind down-card plays -------------------------------------------------

{
  const t = table({ seats: [{ id: "A", hand: "", up: "", down: "4♠ K♠" }, { id: "B", hand: "3♦" }], waste: "9♣" });
  check("a down-card index out of range is refused", applyMove(t, "A", { kind: "play-blind", index: 2 }).code === "bad-card");
  check("a non-integer index is refused", applyMove(t, "A", { kind: "play-blind", index: "1" }).code === "bad-card");
  const r = applyMove(t, "A", { kind: "play-blind", index: 1 });
  check("a legal blind card goes on the pile", r.event.kind === "blind-play" && t.wastePile.at(-1).rank === "K" && show(seatOf(t, "A").downcards) === "4♠");
  check("and play moves on", t.currentPlayerId === "B");
}
{
  const t = table({ seats: [{ id: "A", hand: "", up: "", down: "4♠ K♠" }, { id: "B", hand: "3♦" }], waste: "6♦ 9♣" });
  const r = applyMove(t, "A", { kind: "play-blind", index: 0 });
  check("an illegal blind card is revealed", r.ok && r.event.kind === "blind-fail" && show(r.event.cards) === "4♠");
  check("and the player takes the pile and the card", show(seatOf(t, "A").hand) === "6♦ 9♣ 4♠" && t.wastePile.length === 0 && r.event.pickedUp === 3);
  check("and the card is no longer face down", show(seatOf(t, "A").downcards) === "K♠");
  check("and play moves on", t.currentPlayerId === "B");
}
{
  const t = table({ seats: [{ id: "A", hand: "", up: "J♠", down: "4♠" }, { id: "B", hand: "3♦" }] });
  check("down-cards can't be played while up-cards remain", applyMove(t, "A", { kind: "play-blind", index: 0 }).code === "wrong-source");
}

// --- going out, ranked elimination -----------------------------------------

{
  const t = table({ seats: [{ id: "A", hand: "", up: "", down: "K♠" }, { id: "B", hand: "3♦" }, { id: "C", hand: "4♦" }], waste: "9♣" });
  const r = applyMove(t, "A", { kind: "play-blind", index: 0 });
  check("playing your last card takes you out in 1st", r.event.place === 1 && t.finishOrder.join() === "A");
  check("play carries on with the rest", t.currentPlayerId === "B" && !isGameOver(t));
}
{
  // A 3-player game played down to the last player holding cards.
  const t = table({
    seats: [{ id: "A", hand: "A♠" }, { id: "B", hand: "2♦ 5♣" }, { id: "C", hand: "2♠" }],
    waste: "K♣",
  });
  play(t, "A", "A♠");
  check("A out first", t.finishOrder.join() === "A" && t.currentPlayerId === "B");
  play(t, "B", "2♦");
  check("B plays on", t.currentPlayerId === "C");
  play(t, "C", "2♠");
  check("C out second, and only B is left", t.finishOrder.join() === "A,C");
  check("the game is over", isGameOver(t) && t.currentPlayerId === null);
  check("B is the shithead", shitheadId(t) === "B");
}
{
  const t = table({ seats: [{ id: "A", hand: "10♠" }, { id: "B", hand: "3♦" }, { id: "C", hand: "4♦" }], waste: "9♣" });
  const r = play(t, "A", "10♠");
  check("going out on a 10 burns, but you don't go again", r.event.burned && !r.event.goAgain && r.event.place === 1 && t.currentPlayerId === "B");
}
{
  const t = table({ seats: [{ id: "A", hand: "Q♠" }, { id: "B", hand: "3♦" }], waste: "9♣" });
  play(t, "A", "Q♠");
  check("2 players: the first out ends the game", isGameOver(t) && shitheadId(t) === "B" && t.currentPlayerId === null);
  check("and nobody can move after that", applyMove(t, "B", { kind: "pick-up" }).code === "not-your-turn");
}
{
  const t = table({ seats: [{ id: "A", hand: "Q♠" }, { id: "B", hand: "3♦" }], waste: "9♣", deck: "5♥" });
  play(t, "A", "Q♠");
  check("an empty hand with cards left in the deck isn't out — it redraws", t.finishOrder.length === 0 && show(seatOf(t, "A").hand) === "5♥");
}

// --- first player across N seats -------------------------------------------

{
  const t = table({ seats: ABCD({ A: { hand: "5♠ 6♠ 9♠", up: "J♠" }, B: { hand: "4♦ 9♦ 9♥", up: "K♦" }, C: { hand: "A♠ 2♦", up: "7♣" }, D: { hand: "Q♠", up: "K♠" } }) });
  check("the lowest card across all seats leads", determineFirstPlayer(t) === "B");
  t.seats[1].hand = cs("5♦ 9♦ 9♥");
  t.seats[2].upcards = cs("5♣");
  check("a tie on the lowest goes to the earliest seat (assumed)", determineFirstPlayer(t) === "A");
  t.seats.forEach((s) => { s.hand = cs("2♠"); s.upcards = []; });
  t.seats[3].hand = cs("A♠");
  check("2s count as the highest when looking for the lead", determineFirstPlayer(t) === "D");
}

report();
