import type * as Party from "partykit/server";
import {
  MAX_PLAYERS,
  type ClientMessage,
  type ErrorCode,
  type PublicPlayer,
  type RoomPhase,
  type RoomStateMessage,
  type ServerMessage,
} from "./shared/protocol";

/** A seat, plus anything the server knows that clients must not all see. */
type Seat = PublicPlayer;

/**
 * One PartyKit room instance == one game room, keyed by its room code.
 *
 * Milestone 1: presence only. The room tracks who is seated, who is
 * currently connected, and broadcasts that roster. Game state (deck, hands)
 * will live here too, and the authoritative rules engine with it — clients
 * only ever receive what they are allowed to see.
 */
export default class ShitheadRoom implements Party.Server {
  /**
   * No hibernation: rooms hold live game state in memory and only exist for
   * the length of a game, so we keep the instance awake while anyone is in it.
   */
  readonly options: Party.ServerOptions = { hibernate: false };

  /** Seats in join order. Index === seat number. */
  private seats: Seat[] = [];

  /** connection id -> player id, so a dropped socket can be traced to a seat. */
  private connectionToPlayer = new Map<string, string>();

  private phase: RoomPhase = "lobby";

  constructor(readonly room: Party.Room) {}

  /** The room code, uppercased for display. */
  private get code(): string {
    return this.room.id.toUpperCase();
  }

  onConnect(_conn: Party.Connection, _ctx: Party.ConnectionContext) {
    // Nothing yet: a socket is anonymous until it sends `join`. Sending the
    // roster before then would leak the room contents to any idle connection.
  }

  onMessage(raw: string, conn: Party.Connection) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return this.sendError(conn, "bad-message", "Could not parse that message.");
    }

    switch (msg?.type) {
      case "join":
        return this.handleJoin(msg.playerId, msg.name, conn);
      case "leave":
        return this.handleLeave(conn);
      default:
        return this.sendError(conn, "bad-message", "Unknown message type.");
    }
  }

  onClose(conn: Party.Connection) {
    this.handleDisconnect(conn);
  }

  onError(conn: Party.Connection) {
    this.handleDisconnect(conn);
  }

  // -------------------------------------------------------------------------

  private handleJoin(playerId: string, rawName: string, conn: Party.Connection) {
    if (typeof playerId !== "string" || !playerId) {
      return this.sendError(conn, "bad-message", "Missing player id.");
    }

    const name = typeof rawName === "string" ? rawName.trim().slice(0, 16) : "";
    if (!name) {
      return this.sendError(conn, "name-required", "Pick a name first.");
    }

    const existing = this.seats.find((s) => s.id === playerId);

    if (existing) {
      // Reconnect (or a second tab as the same player): reclaim the seat.
      existing.name = name;
      existing.connected = true;
    } else {
      if (this.seats.length >= MAX_PLAYERS) {
        return this.sendError(
          conn,
          "room-full",
          `Room ${this.code} already has ${MAX_PLAYERS} players.`,
        );
      }
      this.seats.push({
        id: playerId,
        name,
        seat: this.seats.length,
        connected: true,
      });
    }

    // Drop any older socket bound to this same player (e.g. a stale tab).
    for (const [connectionId, boundPlayerId] of this.connectionToPlayer) {
      if (boundPlayerId === playerId && connectionId !== conn.id) {
        this.connectionToPlayer.delete(connectionId);
        this.room.getConnection(connectionId)?.close();
      }
    }
    this.connectionToPlayer.set(conn.id, playerId);

    this.send(conn, { type: "welcome", you: playerId, code: this.code });
    this.broadcastRoom();
  }

  /** Deliberate exit: give the seat up entirely and renumber the rest. */
  private handleLeave(conn: Party.Connection) {
    const playerId = this.connectionToPlayer.get(conn.id);
    if (!playerId) return;

    this.connectionToPlayer.delete(conn.id);
    this.seats = this.seats
      .filter((s) => s.id !== playerId)
      .map((s, i) => ({ ...s, seat: i }));

    this.broadcastRoom();
  }

  /**
   * Dropped socket: keep the seat but mark it disconnected, so a reload can
   * reclaim it. In the lobby there's no game to preserve, so an unoccupied
   * seat is released outright.
   */
  private handleDisconnect(conn: Party.Connection) {
    const playerId = this.connectionToPlayer.get(conn.id);
    if (!playerId) return;
    this.connectionToPlayer.delete(conn.id);

    if (this.phase === "lobby") {
      this.seats = this.seats
        .filter((s) => s.id !== playerId)
        .map((s, i) => ({ ...s, seat: i }));
    } else {
      const seat = this.seats.find((s) => s.id === playerId);
      if (seat) seat.connected = false;
    }

    this.broadcastRoom();
  }

  // -------------------------------------------------------------------------

  private roomState(): RoomStateMessage {
    return {
      type: "room",
      code: this.code,
      phase: this.phase,
      players: this.seats.map((s) => ({ ...s })),
      hostId: this.seats[0]?.id ?? null,
    };
  }

  /**
   * Only ever send room contents to sockets that hold a seat. Using
   * `room.broadcast` would also reach sockets that haven't joined, or were
   * refused one — which is exactly the kind of leak this server exists to
   * avoid, and matters far more once hands are in play.
   */
  private broadcastRoom() {
    const payload = JSON.stringify(this.roomState());
    for (const connectionId of this.connectionToPlayer.keys()) {
      this.room.getConnection(connectionId)?.send(payload);
    }
  }

  private send(conn: Party.Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }

  /** Refusals are terminal: the socket is told why, then dropped. */
  private sendError(conn: Party.Connection, code: ErrorCode, message: string) {
    this.send(conn, { type: "error", code, message });
    conn.close(1000, code);
  }
}

ShitheadRoom satisfies Party.Worker;
