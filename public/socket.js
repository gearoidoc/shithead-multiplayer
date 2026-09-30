/**
 * Thin reconnecting WebSocket wrapper for a room.
 *
 * Deliberately dependency-free (and so build-step-free, like the
 * single-player version): the server exposes rooms at a stable URL,
 *   /parties/<party name>/<room id>
 * which is all we need. Auto-reconnect lives here so milestone 5 can build
 * rejoin/resume on top of it.
 */

/**
 * The URL namespace for rooms: PartyServer derives it from the Durable
 * Object binding name in wrangler.jsonc (`Room`), kebab-cased.
 */
const PARTY_NAME = "room";

/** Where the room server lives, when it isn't serving this page itself. */
const DEV_HOST = "127.0.0.1:8787";

/**
 * The client is served by the same Worker as the room server, in dev and
 * when deployed, so same-origin is the normal case. `?host=` overrides it, for when
 * the static client ends up hosted somewhere else.
 */
export function partyHost() {
  const override = new URLSearchParams(location.search).get("host");
  if (override) return override;
  if (location.protocol === "http:" || location.protocol === "https:") {
    return location.host;
  }
  return DEV_HOST;
}

export function roomUrl(roomId) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${partyHost()}/parties/${PARTY_NAME}/${encodeURIComponent(roomId)}`;
}

export class RoomSocket {
  /**
   * @param {object} opts
   * @param {string} opts.room                     room id (the room code, lowercased)
   * @param {(msg: any) => void} opts.onMessage    parsed server message
   * @param {(status: "connecting"|"open"|"reconnecting"|"closed") => void} opts.onStatus
   */
  constructor({ room, onMessage, onStatus }) {
    this.room = room;
    this.onMessage = onMessage;
    this.onStatus = onStatus ?? (() => {});
    /** Messages sent before the socket opened, flushed on open. */
    this.queue = [];
    this.attempt = 0;
    this.closedByUs = false;
    this.ws = null;
    this.retryTimer = null;
    this.#open();
  }

  #open() {
    this.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(roomUrl(this.room));
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.attempt = 0;
      this.onStatus("open");
      const pending = this.queue;
      this.queue = [];
      for (const msg of pending) this.send(msg);
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    });

    ws.addEventListener("close", () => {
      if (this.closedByUs) return this.onStatus("closed");
      this.#scheduleRetry();
    });
  }

  #scheduleRetry() {
    this.attempt += 1;
    // 0.5s, 1s, 2s, 4s, 8s, then hold at 10s.
    const delay = Math.min(500 * 2 ** (this.attempt - 1), 10_000);
    this.onStatus("reconnecting");
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#open(), delay);
  }

  /** Send now if open, otherwise queue until the socket comes up. */
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
