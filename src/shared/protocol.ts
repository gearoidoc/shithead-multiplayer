/**
 * Wire protocol between the browser client and the room server.
 *
 * The client is plain JS (no build step), so it can't import these types —
 * this file is the single written source of truth for the message shapes.
 * Keep `public/app.js` in sync by hand when changing anything here.
 */

import type { Card } from "./cards";
import type { CardId, TableEvent } from "../rules";

export type { CardId, TableEvent };

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;

/** Room codes are 4 characters from an unambiguous alphabet (no O/0, I/1). */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 4;

/** A seat at the table, as everyone is allowed to see it. */
export type PublicPlayer = {
  /** Stable, client-generated id. Survives a reload/reconnect. */
  id: string;
  name: string;
  /** 0-based, assigned in join order; also the seating order round the table. */
  seat: number;
  connected: boolean;
};

/**
 * Phases the room moves through. `finished` once only one player is left
 * holding cards.
 */
export type RoomPhase = "lobby" | "swap" | "playing" | "finished";

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type JoinMessage = {
  type: "join";
  /** Stable id the client persists in localStorage. */
  playerId: string;
  name: string;
};

/** Deliberate exit (as opposed to a dropped socket), frees the seat. */
export type LeaveMessage = { type: "leave" };

/** Host only, from the lobby, with at least MIN_PLAYERS seated. */
export type StartGameMessage = { type: "start-game" };

/**
 * Swap one of your hand cards with one of your own face-up cards, during the
 * swap phase. Both indices address the sender's own cards — there is no
 * player field, because the server takes that from the connection.
 */
export type SwapMessage = {
  type: "swap";
  handIndex: number;
  upcardIndex: number;
};

/**
 * Mark yourself done swapping (or not, with `ready: false`). Play begins
 * once every connected player is ready.
 */
export type ReadyMessage = { type: "ready"; ready: boolean };

/**
 * On your turn, play one or more cards of the same rank from your hand —
 * or, once that's empty, from your face-up cards. Cards are named by
 * identity rather than index, so a stale client view can't play the wrong
 * card: the server checks you actually hold each one, in that zone.
 */
export type PlayMessage = {
  type: "play";
  source: "hand" | "upcards";
  cards: CardId[];
};

/**
 * Once your hand and face-up cards are gone, turn over one face-down card
 * by position. Nobody, including you, knows what it is until it's played;
 * if it can't go, you take the pile and the card.
 */
export type PlayBlindMessage = { type: "play-blind"; index: number };

/** On your turn, take the whole pile into your hand instead of playing. */
export type PickUpMessage = { type: "pick-up" };

/**
 * Host only, once the game is dealt: take a player who has gone away
 * (disconnected) out of the game, so the table isn't stuck waiting on them.
 * Their cards leave play and they can't rejoin this game.
 */
export type RemovePlayerMessage = { type: "remove-player"; playerId: string };

export type ClientMessage =
  | JoinMessage
  | LeaveMessage
  | StartGameMessage
  | SwapMessage
  | ReadyMessage
  | PlayMessage
  | PlayBlindMessage
  | PickUpMessage
  | RemovePlayerMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Sent to a single connection once its `join` is accepted. */
export type WelcomeMessage = {
  type: "welcome";
  /** Which player in `RoomStateMessage.players` is the recipient. */
  you: string;
  code: string;
};

/** Broadcast to everyone whenever the roster changes. */
export type RoomStateMessage = {
  type: "room";
  code: string;
  phase: RoomPhase;
  /** Ordered by seat. */
  players: PublicPlayer[];
  /**
   * Seat 0 in the lobby: the only player who can start the game. Once the
   * game is dealt, the first connected seat still at the table — so a host
   * who drops doesn't leave nobody able to remove an absent player.
   */
  hostId: string | null;
};

/**
 * One seat as everyone at the table is allowed to see it.
 *
 * Note what is *not* here: nobody's hand cards, and nobody's face-down
 * cards — not even your own, since the rules say you play those blind.
 * Only counts of each. This type is the hidden-information guarantee, so
 * don't add a `hand` or `downcards` field to it.
 */
export type SeatView = {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
  /** Face-up cards are public by definition. */
  upcards: Card[];
  handCount: number;
  downcardCount: number;
  /** Done swapping. Meaningless outside the swap phase. */
  ready: boolean;
  /** 1-based finishing position once out of cards; null while still in. */
  place: number | null;
  /** Taken out of the game by the host. Ranks below everyone who stayed. */
  removed: boolean;
};

/**
 * The table from one player's point of view, sent per-connection — never
 * broadcast, because `hand` differs for every recipient.
 */
export type GameStateMessage = {
  type: "game";
  code: string;
  phase: RoomPhase;
  /** Which seat in `players` is the recipient. */
  you: string;
  /** The recipient's own hand. The only private cards they ever receive. */
  hand: Card[];
  /** Ordered by seat. */
  players: SeatView[];
  hostId: string | null;
  deckCount: number;
  wasteTop: Card | null;
  /**
   * Up to the top four cards of the pile, oldest first. Public at a real
   * table, and needed to see a four-of-a-kind building across turns.
   */
  wasteRecent: Card[];
  wasteCount: number;
  burnedCount: number;
  /** Whose turn it is. Null until the swap phase ends. */
  currentPlayerId: string | null;
  /** 1 plays up through the seats, -1 plays down. Reversed by a single 8. */
  turnDirection: 1 | -1;
  /** What the last move did, for everyone to see. Null before the first. */
  lastEvent: TableEvent | null;
  /** Player ids in the order they went out: index 0 finished 1st. */
  finishOrder: string[];
  /**
   * The last player holding cards, once the game is over. Null if the game
   * ended because removals left only one player.
   */
  shitheadId: string | null;
  /** Players the host removed, in the order removed. */
  removedOrder: string[];
};

export type ErrorCode =
  | "room-full"
  | "bad-message"
  | "name-required"
  | "game-in-progress"
  | "not-host"
  | "not-enough-players"
  | "already-started"
  | "wrong-phase"
  | "bad-card"
  | "not-your-turn"
  | "wrong-source"
  | "illegal-play"
  | "nothing-to-pick-up"
  | "cant-remove"
  | "removed";

export type ErrorMessage = {
  type: "error";
  code: ErrorCode;
  message: string;
  /**
   * True when the refusal means the recipient can't be in this room at all
   * (the room is full, the game already started) and the server has closed
   * the socket. False for a rejected action the player can recover from,
   * like a non-host pressing start — the socket stays open.
   */
  fatal: boolean;
};

export type ServerMessage =
  | WelcomeMessage
  | RoomStateMessage
  | GameStateMessage
  | ErrorMessage;
