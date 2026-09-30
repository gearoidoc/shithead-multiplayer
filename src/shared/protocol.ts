/**
 * Wire protocol between the browser client and the room server.
 *
 * The client is plain JS (no build step), so it can't import these types —
 * this file is the single written source of truth for the message shapes.
 * Keep `public/app.js` in sync by hand when changing anything here.
 */

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

/** Phases the room moves through. Only `lobby` exists in milestone 1. */
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

export type ClientMessage = JoinMessage | LeaveMessage;

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

export type ErrorCode = "room-full" | "bad-message" | "name-required";

export type ErrorMessage = {
  type: "error";
  code: ErrorCode;
  message: string;
};

export type ServerMessage = WelcomeMessage | RoomStateMessage | ErrorMessage;
