/**
 * Shared test harness.
 *
 * The tests wait on *conditions*, never on fixed delays. Fixed sleeps are
 * fine against a local dev server and start failing the moment the suite is
 * pointed at a real deployment, where a round trip can take an order of
 * magnitude longer — which is exactly when the suite most needs to be
 * trustworthy.
 */

import WebSocket from "ws";

export const HOST = process.env.PARTY_HOST ?? "127.0.0.1:8787";

const LOCAL = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|$)/.test(HOST);
const SCHEME = LOCAL ? "ws" : "wss";

/** How long any single condition gets before it's called a failure. */
const TIMEOUT = Number(process.env.TEST_TIMEOUT_MS ?? (LOCAL ? 5000 : 15000));

/** A short settle for asserting a *negative* — that nothing else arrives. */
export const QUIET_MS = Number(process.env.TEST_QUIET_MS ?? (LOCAL ? 150 : 600));

export const cardKey = (card) => `${card.rank}${card.suit}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A unique room per run, so repeated runs never collide. */
export const roomName = (prefix) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export function client(label, room) {
  const ws = new WebSocket(`${SCHEME}://${HOST}/parties/room/${room}`);
  const msgs = [];
  const waiters = new Set();
  let closed = false;

  const settleWaiters = () => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate()) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  ws.on("message", (data) => {
    msgs.push(JSON.parse(data.toString()));
    settleWaiters();
  });
  ws.on("close", () => {
    closed = true;
    settleWaiters();
  });
  ws.on("error", () => {});

  const self = {
    label,
    ws,
    msgs,
    open: new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    }),
    send: (msg) => ws.send(JSON.stringify(msg)),
    last: (type) => [...msgs].reverse().find((m) => m.type === type),
    all: (type) => msgs.filter((m) => m.type === type),
    get closed() {
      return closed;
    },
    /** This client's own seat, as the latest game view shows it. */
    me: () => {
      const game = self.last("game");
      return game?.players.find((p) => p.id === game.you);
    },

    /** Resolve once `predicate()` holds. Rejects if it never does. */
    waitFor(predicate, what = "condition") {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.add(waiter);
        setTimeout(() => {
          if (!waiters.has(waiter)) return;
          waiters.delete(waiter);
          reject(
            new Error(
              `[${label}] timed out after ${TIMEOUT}ms waiting for ${what}. ` +
                `Received: ${msgs.map((m) => m.type).join(", ") || "nothing"}`,
            ),
          );
        }, TIMEOUT).unref?.();
      });
    },

    /** Wait for a message of `type` to arrive (or already have arrived). */
    waitForType(type, what = type) {
      return self.waitFor(() => !!self.last(type), `a ${what} message`);
    },

    /**
     * Wait for the *next* message of `type`, ignoring any already received.
     * Used where a second copy of the same message type is the signal.
     */
    waitForNext(type, what = type) {
      const seen = self.all(type).length;
      return self.waitFor(
        () => self.all(type).length > seen,
        `another ${what} message`,
      );
    },
  };

  return self;
}

/** Join a room and wait until the server has acknowledged the seat. */
export async function seat(room, label, id, name) {
  const c = client(label, room);
  await c.open;
  c.send({ type: "join", playerId: id, name });
  // Either we're in (welcome) or we were refused (error) — both are settled.
  await c.waitFor(
    () => !!c.last("welcome") || !!c.last("error"),
    "the join to be accepted or refused",
  );
  return c;
}

/** Collects pass/fail results and exits with the right code. */
export function checker() {
  const checks = [];
  return {
    check: (name, ok) => checks.push([name, !!ok]),
    report(closeables = []) {
      let failed = 0;
      for (const [name, ok] of checks) {
        console.log(`${ok ? "  ok  " : "FAILED"}  ${name}`);
        if (!ok) failed += 1;
      }
      console.log(`\n${checks.length - failed}/${checks.length} passed`);
      for (const c of closeables) c.ws.close();
      process.exit(failed ? 1 : 0);
    },
  };
}
