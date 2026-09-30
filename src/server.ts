import {
  Server,
  routePartykitRequest,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "partyserver";
import { FIRST_PLAYER_RANK_ORDER, deal, type Card } from "./shared/cards";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type ClientMessage,
  type ErrorCode,
  type GameStateMessage,
  type PublicPlayer,
  type RoomPhase,
  type RoomStateMessage,
  type SeatView,
  type ServerMessage,
} from "./shared/protocol";

/**
 * A seat, plus the cards the server holds for it.
 *
 * `hand` and `downcards` must never reach any client except as counts (and
 * `hand` only reaches its own owner in full). Everything that goes on the
 * wire is built by `publicPlayer` / `seatView` below, field by field —
 * deliberately not by spreading a Seat, so that adding a field here can't
 * silently leak it.
 */
type Seat = PublicPlayer & {
  hand: Card[];
  upcards: Card[];
  downcards: Card[];
  /** Done swapping. Only meaningful during the swap phase. */
  ready: boolean;
};

/**
 * One Durable Object instance == one game room, keyed by its room code.
 *
 * Milestone 1: presence only. The room tracks who is seated, who is
 * currently connected, and broadcasts that roster. Game state (deck, hands)
 * will live here too, and the authoritative rules engine with it — clients
 * only ever receive what they are allowed to see.
 */
export class Room extends Server<Env> {
  /**
   * No hibernation: rooms hold live game state in memory and only exist for
   * the length of a game, so we keep the instance awake while anyone is in it.
   */
  static options = { hibernate: false };

  /** Seats in join order. Index === seat number. */
  private seats: Seat[] = [];

  /** connection id -> player id, so a dropped socket can be traced to a seat. */
  private connectionToPlayer = new Map<string, string>();

  private phase: RoomPhase = "lobby";

  /** The draw pile. Empty until the game is dealt. */
  private deck: Card[] = [];

  private wastePile: Card[] = [];

  /** Burned by a 10 or a four-of-a-kind; out of the game entirely. */
  private burned: Card[] = [];

  /** Whose turn it is. Null until the swap phase ends. */
  private currentPlayerId: string | null = null;

  /** 1 plays up through the seats, -1 plays down. A single 8 reverses it. */
  private turnDirection: 1 | -1 = 1;

  /** The room code, uppercased for display. */
  private get code(): string {
    return this.name.toUpperCase();
  }

  onConnect(_conn: Connection, _ctx: ConnectionContext) {
    // Nothing yet: a socket is anonymous until it sends `join`. Sending the
    // roster before then would leak the room contents to any idle connection.
  }

  onMessage(conn: Connection, raw: WSMessage) {
    if (typeof raw !== "string") {
      return this.sendError(conn, "bad-message", "Expected a text message.");
    }

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
      case "start-game":
        return this.handleStartGame(conn);
      case "swap":
        return this.handleSwap(conn, msg.handIndex, msg.upcardIndex);
      case "ready":
        return this.handleReady(conn, msg.ready);
      default:
        return this.sendError(conn, "bad-message", "Unknown message type.");
    }
  }

  onClose(conn: Connection) {
    this.handleDisconnect(conn);
  }

  onError(conn: Connection) {
    this.handleDisconnect(conn);
  }

  // -------------------------------------------------------------------------

  private handleJoin(playerId: string, rawName: string, conn: Connection) {
    if (typeof playerId !== "string" || !playerId) {
      return this.sendError(conn, "bad-message", "Missing player id.");
    }

    const name = typeof rawName === "string" ? rawName.trim().slice(0, 16) : "";
    if (!name) {
      return this.refuse(conn, "name-required", "Pick a name first.");
    }

    const existing = this.seats.find((s) => s.id === playerId);

    if (existing) {
      // Reconnect (or a second tab as the same player): reclaim the seat.
      existing.name = name;
      existing.connected = true;
    } else {
      if (this.phase !== "lobby") {
        // A seat that wasn't dealt in has no cards, so a newcomer can't be
        // added to a game in progress. Reconnecting players take the branch
        // above and keep their seat.
        return this.refuse(
          conn,
          "game-in-progress",
          `The game in room ${this.code} has already started.`,
        );
      }
      if (this.seats.length >= MAX_PLAYERS) {
        return this.refuse(
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
        hand: [],
        upcards: [],
        downcards: [],
        ready: false,
      });
    }

    // Drop any older socket bound to this same player (e.g. a stale tab).
    for (const [connectionId, boundPlayerId] of this.connectionToPlayer) {
      if (boundPlayerId === playerId && connectionId !== conn.id) {
        this.connectionToPlayer.delete(connectionId);
        this.getConnection(connectionId)?.close();
      }
    }
    this.connectionToPlayer.set(conn.id, playerId);

    this.send(conn, { type: "welcome", you: playerId, code: this.code });
    this.broadcastState();
  }

  /**
   * Deliberate exit. In the lobby the seat is given up and the rest
   * renumbered; mid-game it can't be, because renumbering would shuffle a
   * live table's seating, so it degrades to the same handling as a dropped
   * socket. Abandoning a running game properly is milestone 5's problem.
   */
  private handleLeave(conn: Connection) {
    const playerId = this.connectionToPlayer.get(conn.id);
    if (!playerId) return;

    if (this.phase !== "lobby") return this.handleDisconnect(conn);

    this.connectionToPlayer.delete(conn.id);
    this.seats = this.seats.filter((s) => s.id !== playerId);
    this.renumberSeats();

    this.broadcastState();
  }

  /**
   * Dropped socket: keep the seat but mark it disconnected, so a reload can
   * reclaim it. In the lobby there's no game to preserve, so an unoccupied
   * seat is released outright.
   */
  private handleDisconnect(conn: Connection) {
    const playerId = this.connectionToPlayer.get(conn.id);
    if (!playerId) return;
    this.connectionToPlayer.delete(conn.id);

    if (this.phase === "lobby") {
      this.seats = this.seats.filter((s) => s.id !== playerId);
      this.renumberSeats();
    } else {
      const seat = this.seats.find((s) => s.id === playerId);
      if (seat) seat.connected = false;
    }

    this.broadcastState();
  }

  /**
   * Host only, from the lobby, with at least MIN_PLAYERS seated. Deals and
   * moves the room into the swap phase.
   */
  private handleStartGame(conn: Connection) {
    const playerId = this.connectionToPlayer.get(conn.id);
    if (!playerId) return;

    if (this.phase !== "lobby") {
      return this.sendError(conn, "already-started", "The game is already under way.");
    }
    if (playerId !== this.seats[0]?.id) {
      return this.sendError(conn, "not-host", "Only the host can start the game.");
    }
    if (this.seats.length < MIN_PLAYERS) {
      return this.sendError(
        conn,
        "not-enough-players",
        `You need at least ${MIN_PLAYERS} players to start.`,
      );
    }

    const dealt = deal(this.seats.length);
    this.seats.forEach((seat, i) => {
      const cards = dealt.hands[i]!;
      seat.hand = cards.hand;
      seat.upcards = cards.upcards;
      seat.downcards = cards.downcards;
    });
    this.deck = dealt.deck;
    this.wastePile = [];
    this.burned = [];
    this.currentPlayerId = null;
    this.turnDirection = 1;
    this.seats.forEach((seat) => {
      seat.ready = false;
    });

    this.phase = "swap";
    this.broadcastState();
  }

  /**
   * Swap one of the sender's hand cards with one of their own face-up cards.
   * Both indices address that player's own cards only — the seat comes from
   * the connection, so one player can't reach into another's.
   */
  private handleSwap(conn: Connection, handIndex: number, upcardIndex: number) {
    const seat = this.seatFor(conn);
    if (!seat) return;

    if (this.phase !== "swap") {
      return this.sendError(conn, "wrong-phase", "Cards can only be swapped before play starts.");
    }

    const handCard = seat.hand[handIndex];
    const upcard = seat.upcards[upcardIndex];
    if (!Number.isInteger(handIndex) || !Number.isInteger(upcardIndex) || !handCard || !upcard) {
      return this.sendError(conn, "bad-card", "That isn't one of your cards.");
    }

    seat.hand[handIndex] = upcard;
    seat.upcards[upcardIndex] = handCard;

    // Changing your mind un-readies you, rather than being refused outright.
    seat.ready = false;

    this.broadcastState();
  }

  /**
   * Mark the sender done (or not) swapping. Once every connected player is
   * ready, the swap phase ends and play begins.
   */
  private handleReady(conn: Connection, ready: boolean) {
    const seat = this.seatFor(conn);
    if (!seat) return;

    if (this.phase !== "swap") {
      return this.sendError(conn, "wrong-phase", "There's nothing to be ready for.");
    }

    seat.ready = ready !== false;

    // Disconnected seats aren't waited on — otherwise one dropped player
    // would stall the table indefinitely.
    const waitingOn = this.seats.filter((s) => s.connected && !s.ready);
    if (waitingOn.length === 0) {
      this.phase = "playing";
      this.currentPlayerId = this.determineFirstPlayer();
    }

    this.broadcastState();
  }

  /**
   * Who leads: whoever holds the lowest card in hand or face-up, walking
   * `3,4,...,K,A,2`. Generalised from the single-player version's two-player
   * comparison to any number of seats.
   *
   * **Tie-break:** when several players hold the lowest rank, the earliest
   * seat wins. The single-player version had the same bias (it checked the
   * human before the AI), and this keeps it deterministic. If the real-life
   * house rule differs, this is the one line to change.
   */
  private determineFirstPlayer(): string | null {
    for (const rank of FIRST_PLAYER_RANK_ORDER) {
      const holder = this.seats.find(
        (seat) =>
          seat.hand.some((card) => card.rank === rank) ||
          seat.upcards.some((card) => card.rank === rank),
      );
      if (holder) return holder.id;
    }
    // Only reachable if nobody holds a card at all.
    return this.seats[0]?.id ?? null;
  }

  /** The seat this connection is sitting in, if it holds one. */
  private seatFor(conn: Connection): Seat | undefined {
    const playerId = this.connectionToPlayer.get(conn.id);
    if (!playerId) return undefined;
    return this.seats.find((s) => s.id === playerId);
  }

  /** Seats are numbered by position, so the two must be kept in step. */
  private renumberSeats() {
    this.seats.forEach((seat, i) => {
      seat.seat = i;
    });
  }

  // -------------------------------------------------------------------------

  private roomState(): RoomStateMessage {
    return {
      type: "room",
      code: this.code,
      phase: this.phase,
      players: this.seats.map((s) => this.publicPlayer(s)),
      hostId: this.seats[0]?.id ?? null,
    };
  }

  /**
   * Built field by field on purpose. A spread of `Seat` would put `hand`,
   * `upcards` and `downcards` straight onto the wire.
   */
  private publicPlayer(seat: Seat): PublicPlayer {
    return {
      id: seat.id,
      name: seat.name,
      seat: seat.seat,
      connected: seat.connected,
    };
  }

  /** As above: everything here is public by the rules. Counts, not cards. */
  private seatView(seat: Seat): SeatView {
    return {
      id: seat.id,
      name: seat.name,
      seat: seat.seat,
      connected: seat.connected,
      upcards: seat.upcards.map((card) => ({ ...card })),
      handCount: seat.hand.length,
      downcardCount: seat.downcards.length,
      ready: seat.ready,
    };
  }

  /**
   * The table as one player sees it: their own hand in full, and everyone
   * else — including themselves — reduced to public information.
   */
  private gameStateFor(playerId: string): GameStateMessage {
    const me = this.seats.find((s) => s.id === playerId);
    return {
      type: "game",
      code: this.code,
      phase: this.phase,
      you: playerId,
      hand: (me?.hand ?? []).map((card) => ({ ...card })),
      players: this.seats.map((s) => this.seatView(s)),
      hostId: this.seats[0]?.id ?? null,
      deckCount: this.deck.length,
      wasteTop: this.wastePile.at(-1) ?? null,
      wasteCount: this.wastePile.length,
      burnedCount: this.burned.length,
      currentPlayerId: this.currentPlayerId,
      turnDirection: this.turnDirection,
    };
  }

  /**
   * Send everyone the view for the current phase. In a game that means one
   * tailored message per connection, since each player's hand differs —
   * there is deliberately no shared game-state broadcast to get wrong.
   *
   * Named to avoid shadowing PartyServer's own `broadcast()`, which sends to
   * every connected socket and which this server must never use.
   */
  private broadcastState() {
    if (this.phase === "lobby") return this.broadcastRoom();

    for (const [connectionId, playerId] of this.connectionToPlayer) {
      this.getConnection(connectionId)?.send(
        JSON.stringify(this.gameStateFor(playerId)),
      );
    }
  }

  /**
   * Only ever send room contents to sockets that hold a seat. Using
   * `broadcast()` would also reach sockets that haven't joined, or were
   * refused one — which is exactly the kind of leak this server exists to
   * avoid, and matters far more once hands are in play.
   */
  private broadcastRoom() {
    const payload = JSON.stringify(this.roomState());
    for (const connectionId of this.connectionToPlayer.keys()) {
      this.getConnection(connectionId)?.send(payload);
    }
  }

  private send(conn: Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }

  /**
   * A rejected action the player can recover from — they stay in the room.
   */
  private sendError(conn: Connection, code: ErrorCode, message: string) {
    this.send(conn, { type: "error", code, message, fatal: false });
  }

  /**
   * "You can't be in this room": the socket is told why, then dropped. Used
   * where there's no seat to go back to, so leaving it open would only let
   * the client sit there receiving nothing.
   */
  private refuse(conn: Connection, code: ErrorCode, message: string) {
    this.send(conn, { type: "error", code, message, fatal: true });
    conn.close(1000, code);
  }
}

/**
 * Static assets (the client) are served by the assets handler configured in
 * wrangler.jsonc; anything under /parties/room/<code> is routed to the room
 * Durable Object above.
 */
export default {
  async fetch(request, env) {
    return (
      (await routePartykitRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
