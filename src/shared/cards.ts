/**
 * Cards, deck and deal. Ported from the single-player game
 * (`../gearoidoc.github.io/shithead/game.js`) and generalised from a fixed
 * two players to the 2-4 seats of a room.
 *
 * This lives server-side: the deck and every hidden card stay in the room.
 */

export const SUITS = ["♠", "♦", "♣", "♥"] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
] as const;
export type Rank = (typeof RANKS)[number];

/** 2-10 numeric, J=11, Q=12, K=13, A=14. */
export const VALUES: Record<Rank, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, J: 11, Q: 12, K: 13, A: 14,
};

export type Card = {
  suit: Suit;
  rank: Rank;
  value: number;
};

/** How many cards of each kind every player starts with. */
export const DEAL_PER_PLAYER = { down: 3, up: 3, hand: 3 } as const;

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: VALUES[rank] });
    }
  }
  return deck;
}

/**
 * An unbiased random index below `maxExclusive`.
 *
 * The single-player game uses `Math.random()`, which is fine when the only
 * opponent is in the same tab. Here the server is the trusted dealer for
 * players who can't see each other's cards, so the shuffle uses the CSPRNG,
 * with rejection sampling to avoid the modulo bias that would otherwise
 * skew the deck very slightly.
 */
function randomIndex(maxExclusive: number): number {
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  } while (value >= limit);
  return value % maxExclusive;
}

/** Fisher-Yates, in place, returning the same array for convenience. */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export type DealtHand = {
  hand: Card[];
  upcards: Card[];
  downcards: Card[];
};

export type Deal = {
  /** One entry per seat, in seat order. */
  hands: DealtHand[];
  /** What's left of the deck: the draw pile. */
  deck: Card[];
};

/**
 * Deal a fresh shuffled deck to `seatCount` players: 3 face-down, 3 face-up
 * and 3 hand cards each, the remainder becoming the draw pile.
 *
 * Cards are dealt a category at a time (all down-cards, then all up-cards,
 * then all hands), matching the single-player version.
 */
export function deal(seatCount: number): Deal {
  const deck = shuffle(createDeck());
  const hands: DealtHand[] = Array.from({ length: seatCount }, () => ({
    hand: [],
    upcards: [],
    downcards: [],
  }));

  const rounds = [
    ["downcards", DEAL_PER_PLAYER.down],
    ["upcards", DEAL_PER_PLAYER.up],
    ["hand", DEAL_PER_PLAYER.hand],
  ] as const;

  for (const [key, count] of rounds) {
    for (const seat of hands) {
      seat[key] = deck.splice(0, count);
    }
  }

  return { hands, deck };
}
