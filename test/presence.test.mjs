/**
 * Presence smoke test for the room server (milestone 1).
 *
 * Needs a dev server running:  npm run dev   (then, separately)  npm test
 * Each run uses a fresh random room so repeated runs don't collide.
 */

import WebSocket from "ws";

const HOST = process.env.PARTY_HOST ?? "127.0.0.1:8787";
const ROOM = `test-${Math.random().toString(36).slice(2, 8)}`;
const URL = `ws://${HOST}/parties/room/${ROOM}`;

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function client(label) {
  const ws = new WebSocket(URL);
  const msgs = [];
  let closed = false;
  ws.on("message", (data) => msgs.push(JSON.parse(data.toString())));
  ws.on("close", () => (closed = true));
  ws.on("error", () => {});
  return {
    label,
    ws,
    msgs,
    open: new Promise((resolve) => ws.on("open", resolve)),
    send: (msg) => ws.send(JSON.stringify(msg)),
    last: (type) => [...msgs].reverse().find((m) => m.type === type),
    get closed() {
      return closed;
    },
  };
}

async function join(label, playerId, name) {
  const c = client(label);
  await c.open;
  c.send({ type: "join", playerId, name });
  await settle();
  return c;
}

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);
const roster = (c) => c.last("room")?.players.map((p) => p.name) ?? [];

// --- a player joins an empty room ------------------------------------------
const alice = await join("alice", "id-alice", "Alice");
check("joining player is welcomed by id", alice.last("welcome")?.you === "id-alice");
check("welcome carries the room code, uppercased", alice.last("welcome")?.code === ROOM.toUpperCase());
check("first joiner is seated and hosts", alice.last("room")?.hostId === "id-alice");
check("room starts in the lobby phase", alice.last("room")?.phase === "lobby");

// --- the table fills up ----------------------------------------------------
const bob = await join("bob", "id-bob", "Bob");
check("both players see each other", roster(alice).join() === "Alice,Bob" && roster(bob).join() === "Alice,Bob");

const carol = await join("carol", "id-carol", "Carol");
const dave = await join("dave", "id-dave", "Dave");
check("four players fit", roster(dave).length === 4);
check("seats are numbered in join order", dave.last("room").players.every((p, i) => p.seat === i));

// --- a fifth player is turned away, and told nothing about the room --------
const eve = await join("eve", "id-eve", "Eve");
check("fifth player is refused", eve.last("error")?.code === "room-full");
check("refused player never receives the roster", !eve.last("room"));
check("refused socket is closed", eve.closed);
check("refusal didn't disturb the table", roster(alice).length === 4);

// --- a nameless join is refused too ---------------------------------------
const nameless = await join("nameless", "id-nameless", "   ");
check("blank name is refused", nameless.last("error")?.code === "name-required");
check("nameless player never receives the roster", !nameless.last("room"));

// --- a socket drops --------------------------------------------------------
bob.ws.terminate();
await settle(400);
check("dropped lobby player frees their seat", !roster(alice).includes("Bob"));
check("remaining seats are renumbered", alice.last("room").players.every((p, i) => p.seat === i));

// --- and comes back --------------------------------------------------------
const bobAgain = await join("bob-again", "id-bob", "Bob");
check("returning player is seated again", roster(bobAgain).includes("Bob"));
check("returning player doesn't duplicate a seat", roster(bobAgain).filter((n) => n === "Bob").length === 1);

// --- a second tab as the same player replaces the first -------------------
const bobTab2 = await join("bob-tab2", "id-bob", "Bob");
check("second tab of one player doesn't add a seat", roster(bobTab2).filter((n) => n === "Bob").length === 1);
check("the older tab is dropped", bobAgain.closed);

// --- a deliberate exit -----------------------------------------------------
alice.send({ type: "leave" });
await settle();
check("leaving frees the seat", !roster(carol).includes("Alice"));
check("host passes to the new seat 0", carol.last("room").hostId === carol.last("room").players[0].id);

// --- report ----------------------------------------------------------------
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "  ok  " : "FAILED"}  ${name}`);
  if (!ok) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} passed — final roster: ${roster(carol).join(", ")}`);

for (const c of [alice, bob, carol, dave, eve, nameless, bobAgain, bobTab2]) c.ws.close();
process.exit(failed ? 1 : 0);
