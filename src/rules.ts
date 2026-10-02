/**
 * The rules engine: what may be played, and what happens when it is.
 *
 * Ported from the single-player game (`../gearoidoc.github.io/shithead/
 * game.js` — `getTopCard`, `isUnder7Rule`, `isSpecialRank`, `canPlayCard`,
 * `playCards`, `handleSpecialCards`, `isFourOfAKind`, `burnPile`,
 * `drawBackUpToThree`, `pickUpPile`, `switchTurn`, `checkWinCondition`) and
 * generalised from a fixed `player`/`ai` pair to 2-4 seats.
 *
 * Deliberately pure: no sockets, no PartyServer. The room server owns the
 * connections and decides who is allowed to send what; this file only knows
 * the table. That keeps it testable on its own (`test/rules.test.mjs` runs
 * it straight under Node) and keeps the framework surface in `server.ts`
 * thin.
 *
 * Imports carry their `.ts` extension so Node can load this file directly.
 */

import {
  FIRST_PLAYER_RANK_ORDER,
  RANKS,
  SUITS,
  type Card,
  type Rank,
} from "./shared/cards.ts";

/** The cards one seat holds. The room's own `Seat` type extends this. */
export type PlayerCards = {
  id: string;
  hand: Card[];
  upcards: Card[];
  downcards: Card[];
};

export type Table<S extends PlayerCards = PlayerCards> = {
  /** In seating order. */
  seats: S[];
  /** The draw pile. */
  deck: Card[];
  wastePile: Card[];
  /** Burned by a 10 or a four-of-a-kind; out of the game entirely. */
  burned: Card[];
  /** Whose turn it is. Null before play starts and once the game is over. */
  currentPlayerId: string | null;
  /** 1 plays up through the seats, -1 plays down. A single 8 reverses it. */
  turnDirection: 1 | -1;
  /** Player ids in the order they went out: index 0 finished 1st. */
  finishOrder: string[];
  /**
   * Player ids the host removed from the game, in the order removed. They
   * rank below everyone who stayed, and their cards are out of play.
   */
  removed: string[];
};

/** Where a play comes from. Down-cards are played blind, one at a time. */
export type Source = "hand" | "upcards" | "downcards";

/** A card named by identity, as a client asks to play it. */
export type CardId = { rank: Rank; suit: Card["suit"] };

export type Move =
  | { kind: "play"; source: "hand" | "upcards"; cards: CardId[] }
  | { kind: "play-blind"; index: number }
  | { kind: "pick-up" };

/**
 * What a move did, in public terms: everything here is something every
 * player at a real table would have seen happen.
 */
export type TableEvent = {
  playerId: string;
  /**
   * `play` from hand or up-cards; `blind-play` a down-card that turned out
   * legal; `blind-fail` a down-card that didn't, so the player took the pile
   * and the card; `pick-up` taking the pile by choice; `removed` the host
   * taking this player out of the game.
   */
  kind: "play" | "blind-play" | "blind-fail" | "pick-up" | "removed";
  /** The cards played or revealed. Empty for a pick-up. */
  cards: Card[];
  /** How many cards went into the player's hand (pick-up / blind-fail). */
  pickedUp: number;
  /** The pile was burned, by a 10 or four of a kind. */
  burned: boolean;
  /** The same player goes again. */
  goAgain: boolean;
  /** A single 8 reversed the direction of play. */
  reversed: boolean;
  /** 1-based finishing position, if this move took the player out. */
  place: number | null;
};

export type RuleError =
  | "not-your-turn"
  | "bad-card"
  | "wrong-source"
  | "illegal-play"
  | "nothing-to-pick-up"
  | "cant-remove";

export type Refusal = { ok: false; code: RuleError; message: string };

export type MoveResult = { ok: true; event: TableEvent } | Refusal;

/** Hand cards are topped back up to this while the deck lasts. */
export const HAND_SIZE = 3;

export function emptyTable<S extends PlayerCards>(seats: S[] = []): Table<S> {
  return {
    seats,
    deck: [],
    wastePile: [],
    burned: [],
    currentPlayerId: null,
    turnDirection: 1,
    finishOrder: [],
    removed: [],
  };
}

// ---------------------------------------------------------------------------
// What may be played
// ---------------------------------------------------------------------------

export function getTopCard(table: Table): Card | null {
  return table.wastePile.at(-1) ?? null;
}

export function isSpecialRank(rank: Rank): boolean {
  return rank === "2" || rank === "7" || rank === "8" || rank === "10";
}

/** The last card played was a 7, so the next play must be 7 or lower. */
export function isUnder7Rule(top: Card | null): boolean {
  return top?.rank === "7";
}

/**
 * Whether `card` may legally go on `top`. A line-for-line port of the
 * single-player `canPlayCard`, with the top card passed in rather than read
 * from a global. `test/rules.test.mjs` checks the two agree on every pair.
 */
export function canPlayCard(card: Card, top: Card | null): boolean {
  // An empty pile takes anything.
  if (!top) return true;

  // 2, 8 and 10 are always playable.
  if (card.rank === "2" || card.rank === "8" || card.rank === "10") return true;

  // On a 7, only 7-or-lower or another special card.
  if (isUnder7Rule(top)) {
    return card.value <= 7 || isSpecialRank(card.rank);
  }

  // A 7 itself only goes on something 7 or lower.
  if (card.rank === "7") return top.value <= 7;

  // Anything can follow a 2.
  if (top.rank === "2") return true;

  return card.value >= top.value;
}

/**
 * Which of a seat's zones it must play from: the hand while it has one, then
 * the up-cards, then blind from the down-cards. A client can't choose — a
 * play from the wrong zone is refused, whatever the UI allowed.
 */
export function activeSource(seat: PlayerCards): Source | null {
  if (seat.hand.length > 0) return "hand";
  if (seat.upcards.length > 0) return "upcards";
  if (seat.downcards.length > 0) return "downcards";
  return null;
}

export function isOut(seat: PlayerCards): boolean {
  return (
    seat.hand.length === 0 &&
    seat.upcards.length === 0 &&
    seat.downcards.length === 0
  );
}

/** Four of the same rank on top of the pile, played in one go or not. */
export function isFourOfAKind(pile: Card[]): boolean {
  if (pile.length < 4) return false;
  const topFour = pile.slice(-4);
  return topFour.every((card) => card.rank === topFour[0]!.rank);
}

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

/**
 * Who leads: whoever holds the lowest card in hand or face-up, walking
 * `3,4,...,K,A,2`. Generalised from the single-player version's two-player
 * comparison to any number of seats.
 *
 * **Tie-break:** when several players hold the lowest rank, the earliest
 * seat wins. The single-player version had the same bias (it checked the
 * human before the AI), and this keeps it deterministic. If the real-life
 * house rule differs, this is the one `find` to change.
 */
export function determineFirstPlayer(table: Table): string | null {
  for (const rank of FIRST_PLAYER_RANK_ORDER) {
    const holder = activeSeats(table).find(
      (seat) =>
        seat.hand.some((card) => card.rank === rank) ||
        seat.upcards.some((card) => card.rank === rank),
    );
    if (holder) return holder.id;
  }
  // Only reachable if nobody holds a card at all.
  return activeSeats(table)[0]?.id ?? null;
}

/** Still in the game: neither gone out nor removed by the host. */
export function isActive(table: Table, playerId: string): boolean {
  return !table.finishOrder.includes(playerId) && !table.removed.includes(playerId);
}

/** Seats still in the game, in seating order. */
export function activeSeats<S extends PlayerCards>(table: Table<S>): S[] {
  return table.seats.filter((seat) => isActive(table, seat.id));
}

/** One player left holding cards: they're the shithead, and play is over. */
export function isGameOver(table: Table): boolean {
  return table.seats.length > 0 && activeSeats(table).length <= 1;
}

/**
 * The last player holding cards, once the game is over. Null when the game
 * ended because removals left one player standing: they didn't lose to
 * anyone still at the table, so `removePlayer` ranks them instead.
 */
export function shitheadId(table: Table): string | null {
  return isGameOver(table) ? (activeSeats(table)[0]?.id ?? null) : null;
}

/**
 * The next player to act after `fromId`, walking `turnDirection` round the
 * table and closing over anyone who has already gone out. `fromId` may
 * itself have just gone out — the walk starts from its seat regardless.
 */
export function nextPlayerId(table: Table, fromId: string): string | null {
  const count = table.seats.length;
  const from = table.seats.findIndex((seat) => seat.id === fromId);
  if (from === -1) return null;

  for (let step = 1; step <= count; step += 1) {
    const index = (((from + step * table.turnDirection) % count) + count) % count;
    const seat = table.seats[index]!;
    if (seat.id !== fromId && isActive(table, seat.id)) return seat.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

const fail = (code: RuleError, message: string): Refusal => ({ ok: false, code, message });

const isCardId = (value: unknown): value is CardId =>
  typeof value === "object" &&
  value !== null &&
  (RANKS as readonly unknown[]).includes((value as CardId).rank) &&
  (SUITS as readonly unknown[]).includes((value as CardId).suit);

/**
 * Apply one player's move to the table, or refuse it and change nothing.
 *
 * Every input is treated as hostile: the move comes off the wire, so its
 * shape, the cards it names, the zone it names and whose turn it is are all
 * checked here rather than trusted. The caller only has to make sure the
 * game is in play and that `playerId` is the sender's own seat.
 */
export function applyMove(table: Table, playerId: string, move: Move): MoveResult {
  if (table.currentPlayerId !== playerId) {
    return fail("not-your-turn", "It isn't your turn.");
  }
  const seat = table.seats.find((s) => s.id === playerId);
  if (!seat) return fail("not-your-turn", "You aren't seated at this table.");

  switch (move?.kind) {
    case "play":
      return playFromHandOrUpcards(table, seat, move.source, move.cards);
    case "play-blind":
      return playBlind(table, seat, move.index);
    case "pick-up":
      return pickUp(table, seat);
    default:
      return fail("bad-card", "That isn't a move.");
  }
}

function playFromHandOrUpcards(
  table: Table,
  seat: PlayerCards,
  source: unknown,
  ids: unknown,
): MoveResult {
  if (source !== "hand" && source !== "upcards") {
    return fail("wrong-source", "Cards are played from your hand or your face-up cards.");
  }
  if (source !== activeSource(seat)) {
    return fail(
      "wrong-source",
      activeSource(seat) === "hand"
        ? "Play from your hand until it's empty."
        : "Your face-up cards are next.",
    );
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isCardId)) {
    return fail("bad-card", "Pick at least one card to play.");
  }

  // Resolve each id to a distinct card the player actually holds there.
  const zone = seat[source];
  const indices: number[] = [];
  for (const id of ids) {
    const index = zone.findIndex(
      (card, i) => card.rank === id.rank && card.suit === id.suit && !indices.includes(i),
    );
    if (index === -1) return fail("bad-card", "That isn't one of your cards.");
    indices.push(index);
  }
  const cards = indices.map((i) => zone[i]!);

  if (!cards.every((card) => card.rank === cards[0]!.rank)) {
    return fail("illegal-play", "Cards played together must all be the same rank.");
  }
  if (!canPlayCard(cards[0]!, getTopCard(table))) {
    return fail("illegal-play", `You can't play a ${cards[0]!.rank} on that.`);
  }

  seat[source] = zone.filter((_, i) => !indices.includes(i));
  return resolvePlay(table, seat, cards, "play");
}

function playBlind(table: Table, seat: PlayerCards, index: unknown): MoveResult {
  if (activeSource(seat) !== "downcards") {
    return fail("wrong-source", "Face-down cards are played last.");
  }
  if (!Number.isInteger(index) || !seat.downcards[index as number]) {
    return fail("bad-card", "That isn't one of your face-down cards.");
  }

  const [card] = seat.downcards.splice(index as number, 1) as [Card];

  if (canPlayCard(card, getTopCard(table))) {
    return resolvePlay(table, seat, [card], "blind-play");
  }

  // Turned over and it won't go: the pile and the revealed card both go
  // into the player's hand, and play moves on.
  const pickedUp = table.wastePile.length + 1;
  seat.hand.push(...table.wastePile, card);
  table.wastePile = [];
  table.currentPlayerId = nextPlayerId(table, seat.id);
  return {
    ok: true,
    event: {
      playerId: seat.id,
      kind: "blind-fail",
      cards: [card],
      pickedUp,
      burned: false,
      goAgain: false,
      reversed: false,
      place: null,
    },
  };
}

function pickUp(table: Table, seat: PlayerCards): MoveResult {
  if (table.wastePile.length === 0) {
    return fail("nothing-to-pick-up", "There's nothing to pick up — the pile is empty.");
  }

  const pickedUp = table.wastePile.length;
  seat.hand.push(...table.wastePile);
  table.wastePile = [];
  table.currentPlayerId = nextPlayerId(table, seat.id);
  return {
    ok: true,
    event: {
      playerId: seat.id,
      kind: "pick-up",
      cards: [],
      pickedUp,
      burned: false,
      goAgain: false,
      reversed: false,
      place: null,
    },
  };
}

/**
 * The cards are already out of the player's zone and known to be legal. Put
 * them on the pile, then apply what the single-player `handleSpecialCards`
 * does — plus the confirmed 3-4 player rules for 8s, and ranked elimination.
 */
function resolvePlay(
  table: Table,
  seat: PlayerCards,
  cards: Card[],
  kind: "play" | "blind-play",
): MoveResult {
  table.wastePile.push(...cards);

  const rank = cards[0]!.rank;
  const count = cards.length;

  // A 10, or four of a kind on top, burns the pile and the player goes again.
  const burned = rank === "10" || isFourOfAKind(table.wastePile);
  if (burned) {
    table.burned.push(...table.wastePile);
    table.wastePile = [];
  }

  // 8s (unless they just burned the pile as four of a kind):
  //  - two together: the same player goes again, direction unchanged;
  //  - one: reverses direction;
  //  - three: plays as two then one — go again, then reverse — so the net
  //    effect is a reversal, and play passes in the new direction.
  // A reversal needs three or more still playing. With two left there's no
  // direction to reverse: the next player is the other one either way.
  const eights = rank === "8" && !burned ? count : 0;
  const doubleEight = eights === 2;
  const reversed = (eights === 1 || eights === 3) && activeSeats(table).length >= 3;
  if (reversed) table.turnDirection = table.turnDirection === 1 ? -1 : 1;

  drawBackUpToThree(table, seat);

  // Going out: hand, up-cards and down-cards all empty (and so the deck,
  // since the hand was just topped up from it).
  let place: number | null = null;
  if (isOut(seat)) {
    table.finishOrder.push(seat.id);
    place = table.finishOrder.length;
  }

  const goAgain = (burned || doubleEight) && place === null;

  if (isGameOver(table)) {
    table.currentPlayerId = null;
  } else if (!goAgain) {
    table.currentPlayerId = nextPlayerId(table, seat.id);
  }

  return {
    ok: true,
    event: { playerId: seat.id, kind, cards, pickedUp: 0, burned, goAgain, reversed, place },
  };
}

/** Top the hand back up to three from the draw pile, while it lasts. */
export function drawBackUpToThree(table: Table, seat: PlayerCards) {
  while (seat.hand.length < HAND_SIZE && table.deck.length > 0) {
    seat.hand.push(table.deck.shift()!);
  }
}

/**
 * The host takes a player out of the game — for someone who has gone away
 * and isn't coming back, so the table isn't left waiting on them forever.
 * Who may do this, and to whom, is the room server's call; this only
 * changes the table.
 *
 * The player's cards leave play (onto the burned pile, which is out of the
 * game anyway), and they rank below everyone who stayed. If it was their
 * turn, play moves on. If only one player is left, the game ends, and that
 * player takes the next place rather than being called the shithead.
 */
export function removePlayer(table: Table, playerId: string): MoveResult {
  const seat = table.seats.find((s) => s.id === playerId);
  if (!seat || !isActive(table, playerId)) {
    return fail("cant-remove", "That player is already out of the game.");
  }

  table.burned.push(...seat.hand, ...seat.upcards, ...seat.downcards);
  seat.hand = [];
  seat.upcards = [];
  seat.downcards = [];
  table.removed.push(playerId);

  const left = activeSeats(table);
  if (left.length === 1) table.finishOrder.push(left[0]!.id);

  if (isGameOver(table)) {
    table.currentPlayerId = null;
  } else if (table.currentPlayerId === playerId) {
    table.currentPlayerId = nextPlayerId(table, playerId);
  }
  return {
    ok: true,
    event: {
      playerId,
      kind: "removed",
      cards: [],
      pickedUp: 0,
      burned: false,
      goAgain: false,
      reversed: false,
      place: null,
    },
  };
}
