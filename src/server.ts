import {
  Server,
  routePartykitRequest,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "partyserver";
import { deal, type Card } from "./shared/cards";
import {
  applyMove,
  determineFirstPlayer,
  emptyTable,
  isActive,
  isGameOver,
  removePlayer,
  shitheadId,
  type Move,
  type Table,
  type TableEvent,
} from "./rules";
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
 * The room tracks who is seated and who is connected, holds the whole
 * table (deck, hands, pile), and runs every move through the rules engine
 * in `rules.ts`. Clients only ever receive what they are allowed to see.
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

  /**
   * Deck, pile, turn and finishing order. Replaced on deal, and its `seats`
   * is the same array as `this.seats` from then on — which holds because
   * seats are only ever filtered out (reassigning `this.seats`) in the
   * lobby, before any table exists.
   */
  private table: Table<Seat> = emptyTable();

  /** What the last move did, so every client can say so. */
  private lastEvent: TableEvent | null = null;

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
      case "play":
        return this.handleMove(conn, { kind: "play", source: msg.source, cards: msg.cards });
      case "play-blind":
        return this.handleMove(conn, { kind: "play-blind", index: msg.index });
      case "pick-up":
        return this.handleMove(conn, { kind: "pick-up" });
      case "remove-player":
        return this.handleRemovePlayer(conn, msg.playerId);
      case "play-again":
        return this.handlePlayAgain(conn);
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

    if (existing && this.table.removed.includes(playerId)) {
      return this.refuse(
        conn,
        "removed",
        `You were removed from the game in room ${this.code}.`,
      );
    }

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
   * socket — and the host can remove the seat once it's shown as away.
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
      // Everyone left may already be ready; don't wait on the one who went.
      this.maybeEndSwap();
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
    this.table = { ...emptyTable(this.seats), deck: dealt.deck };
    this.lastEvent = null;
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
    this.maybeEndSwap();
    this.broadcastState();
  }

  /**
   * Once every connected player still in the game is ready, the swap phase
   * ends and play begins. Disconnected seats aren't waited on — otherwise
   * one dropped player would stall the table indefinitely.
   */
  private maybeEndSwap() {
    if (this.phase !== "swap") return;
    const waitingOn = this.seats.filter(
      (s) => s.connected && !s.ready && isActive(this.table, s.id),
    );
    if (waitingOn.length > 0) return;

    this.phase = "playing";
    this.table.currentPlayerId = determineFirstPlayer(this.table);
  }

  /**
   * Host only, once dealt: take an away player out of the game. Restricted
   * to disconnected players, so a host can't kick someone who's playing.
   */
  private handleRemovePlayer(conn: Connection, targetId: string) {
    const seat = this.seatFor(conn);
    if (!seat) return;

    if (this.phase !== "swap" && this.phase !== "playing") {
      return this.sendError(conn, "wrong-phase", "There's no game to remove anyone from.");
    }
    if (seat.id !== this.hostId()) {
      return this.sendError(conn, "not-host", "Only the host can remove a player.");
    }
    const target = this.seats.find((s) => s.id === targetId);
    if (!target) {
      return this.sendError(conn, "cant-remove", "That player isn't at this table.");
    }
    if (target.connected) {
      return this.sendError(
        conn,
        "cant-remove",
        `${target.name} is still connected — only players who have gone away can be removed.`,
      );
    }

    const result = removePlayer(this.table, target.id);
    if (!result.ok) return this.sendError(conn, result.code, result.message);
    this.lastEvent = result.event;

    this.maybeEndSwap();
    if (isGameOver(this.table)) {
      this.phase = "finished";
      this.table.currentPlayerId = null;
    }

    this.broadcastState();
  }

  /**
   * Host only, once the game is over: back to the lobby for another game.
   * Connected players keep their seats in the same order; anyone away or
   * removed is dropped, as a dropped socket would be in the lobby. Going via
   * the lobby, rather than dealing straight away, lets people leave or join
   * between games.
   */
  private handlePlayAgain(conn: Connection) {
    const seat = this.seatFor(conn);
    if (!seat) return;

    if (this.phase !== "finished") {
      return this.sendError(conn, "wrong-phase", "The game isn't over yet.");
    }
    if (seat.id !== this.hostId()) {
      return this.sendError(conn, "not-host", "Only the host can start another game.");
    }

    this.seats = this.seats.filter(
      (s) => s.connected && !this.table.removed.includes(s.id),
    );
    this.renumberSeats();
    for (const s of this.seats) {
      s.hand = [];
      s.upcards = [];
      s.downcards = [];
      s.ready = false;
    }
    this.table = emptyTable();
    this.lastEvent = null;
    this.phase = "lobby";

    this.broadcastState();
  }

  /**
   * Seat 0 in the lobby. Once dealt, the first connected seat still at the
   * table, so the host's powers pass on if the host drops.
   */
  private hostId(): string | null {
    if (this.phase === "lobby") return this.seats[0]?.id ?? null;
    const connected = this.seats.find(
      (s) => s.connected && !this.table.removed.includes(s.id),
    );
    return connected?.id ?? this.seats[0]?.id ?? null;
  }

  /**
   * A play or a pick-up. The seat comes from the connection, never the
   * message; everything else is checked by the rules engine, which leaves
   * the table untouched when it refuses.
   */
  private handleMove(conn: Connection, move: Move) {
    const seat = this.seatFor(conn);
    if (!seat) return;

    if (this.phase !== "playing") {
      return this.sendError(conn, "wrong-phase", "The game isn't in play.");
    }

    const result = applyMove(this.table, seat.id, move);
    if (!result.ok) return this.sendError(conn, result.code, result.message);

    this.lastEvent = result.event;
    if (isGameOver(this.table)) this.phase = "finished";

    this.broadcastState();
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
      hostId: this.hostId(),
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
      upcards: seat.upcards.map((card) => copy(card)),
      handCount: seat.hand.length,
      downcardCount: seat.downcards.length,
      ready: seat.ready,
      place: this.placeOf(seat.id),
      removed: this.table.removed.includes(seat.id),
    };
  }

  private placeOf(playerId: string): number | null {
    const index = this.table.finishOrder.indexOf(playerId);
    return index === -1 ? null : index + 1;
  }

  /** A move, as everyone saw it happen. Field by field, like the rest. */
  private eventView(event: TableEvent): TableEvent {
    return {
      playerId: event.playerId,
      kind: event.kind,
      cards: event.cards.map((card) => copy(card)),
      pickedUp: event.pickedUp,
      burned: event.burned,
      goAgain: event.goAgain,
      reversed: event.reversed,
      place: event.place,
    };
  }

  /**
   * The table as one player sees it: their own hand in full, and everyone
   * else — including themselves — reduced to public information.
   */
  private gameStateFor(playerId: string): GameStateMessage {
    const me = this.seats.find((s) => s.id === playerId);
    const top = this.table.wastePile.at(-1);
    return {
      type: "game",
      code: this.code,
      phase: this.phase,
      you: playerId,
      hand: (me?.hand ?? []).map((card) => copy(card)),
      players: this.seats.map((s) => this.seatView(s)),
      hostId: this.hostId(),
      deckCount: this.table.deck.length,
      wasteTop: top ? copy(top) : null,
      wasteRecent: this.table.wastePile.slice(-4).map((card) => copy(card)),
      wasteCount: this.table.wastePile.length,
      burnedCount: this.table.burned.length,
      currentPlayerId: this.table.currentPlayerId,
      turnDirection: this.table.turnDirection,
      lastEvent: this.lastEvent && this.eventView(this.lastEvent),
      finishOrder: [...this.table.finishOrder],
      shitheadId: shitheadId(this.table),
      removedOrder: [...this.table.removed],
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

/** A card for the wire: a fresh object, built field by field. */
function copy(card: Card): Card {
  return { suit: card.suit, rank: card.rank, value: card.value };
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
