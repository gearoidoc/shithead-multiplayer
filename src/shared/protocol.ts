/**
 * Wire protocol between the browser client and the room server.
 *
 * The client is plain JS (no build step), so it can't import these types —
 * this file is the single written source of truth for the message shapes.
 * Keep `public/app.js` in sync by hand when changing anything here.
 */

import type { Card } from "./cards";

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

/** Phases the room moves through. `playing` and `finished` are not wired up yet. */
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

export type ClientMessage =
  | JoinMessage
  | LeaveMessage
  | StartGameMessage
  | SwapMessage
  | ReadyMessage;

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
  /** Seat 0: the only player who will be able to start the game. */
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
  wasteCount: number;
  burnedCount: number;
  /** Whose turn it is. Null until the swap phase ends. */
  currentPlayerId: string | null;
  /** 1 plays up through the seats, -1 plays down. Reversed by a single 8. */
  turnDirection: 1 | -1;
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
  | "bad-card";

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
