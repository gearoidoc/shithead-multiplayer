/**
 * Presence tests for the room server (milestone 1).
 *
 * Needs a dev server running:  npm run dev   (then, separately)  npm test
 *
 * Point it at a deployment instead with:
 *   PARTY_HOST=shithead-multiplayer.<subdomain>.workers.dev npm test
 */

import { QUIET_MS, checker, client, roomName, seat, sleep } from "./harness.mjs";

const ROOM = roomName("presence");
const { check, report } = checker();
const roster = (c) => c.last("room")?.players.map((p) => p.name) ?? [];

/** Wait until a client's roster matches, so we never race a broadcast. */
const rosterIs = (c, names) =>
  c.waitFor(() => roster(c).join() === names.join(), `roster ${names.join()}`);

// --- a player joins an empty room ------------------------------------------
const alice = await seat(ROOM, "alice", "id-alice", "Alice");
await rosterIs(alice, ["Alice"]);
check("joining player is welcomed by id", alice.last("welcome")?.you === "id-alice");
check("welcome carries the room code, uppercased", alice.last("welcome")?.code === ROOM.toUpperCase());
check("first joiner is seated and hosts", alice.last("room")?.hostId === "id-alice");
check("room starts in the lobby phase", alice.last("room")?.phase === "lobby");

// --- the table fills up ----------------------------------------------------
const bob = await seat(ROOM, "bob", "id-bob", "Bob");
await Promise.all([rosterIs(alice, ["Alice", "Bob"]), rosterIs(bob, ["Alice", "Bob"])]);
check("both players see each other", true);

const carol = await seat(ROOM, "carol", "id-carol", "Carol");
const dave = await seat(ROOM, "dave", "id-dave", "Dave");
await rosterIs(dave, ["Alice", "Bob", "Carol", "Dave"]);
check("four players fit", roster(dave).length === 4);
check("seats are numbered in join order", dave.last("room").players.every((p, i) => p.seat === i));

// --- a fifth player is turned away, and told nothing about the room --------
const eve = await seat(ROOM, "eve", "id-eve", "Eve");
await eve.waitFor(() => eve.closed, "the refused socket to close");
check("fifth player is refused", eve.last("error")?.code === "room-full");
check("that refusal is fatal", eve.last("error")?.fatal === true);
check("refused player never receives the roster", !eve.last("room"));
check("refused socket is closed", eve.closed);
check("refusal didn't disturb the table", roster(alice).length === 4);

// --- a nameless join is refused too ---------------------------------------
const nameless = await seat(ROOM, "nameless", "id-nameless", "   ");
await nameless.waitFor(() => nameless.closed, "the refused socket to close");
check("blank name is refused", nameless.last("error")?.code === "name-required");
check("nameless player never receives the roster", !nameless.last("room"));

// --- a socket drops --------------------------------------------------------
bob.ws.terminate();
await rosterIs(alice, ["Alice", "Carol", "Dave"]);
check("dropped lobby player frees their seat", !roster(alice).includes("Bob"));
check("remaining seats are renumbered", alice.last("room").players.every((p, i) => p.seat === i));

// --- and comes back --------------------------------------------------------
const bobAgain = await seat(ROOM, "bob-again", "id-bob", "Bob");
await rosterIs(bobAgain, ["Alice", "Carol", "Dave", "Bob"]);
check("returning player is seated again", roster(bobAgain).includes("Bob"));
check("returning player doesn't duplicate a seat", roster(bobAgain).filter((n) => n === "Bob").length === 1);

// --- a second tab as the same player replaces the first -------------------
const bobTab2 = await seat(ROOM, "bob-tab2", "id-bob", "Bob");
await bobTab2.waitForType("room");
await bobAgain.waitFor(() => bobAgain.closed, "the older tab to be dropped");
check("second tab of one player doesn't add a seat", roster(bobTab2).filter((n) => n === "Bob").length === 1);
check("the older tab is dropped", bobAgain.closed);

// --- a deliberate exit -----------------------------------------------------
alice.send({ type: "leave" });
await rosterIs(carol, ["Carol", "Dave", "Bob"]);
check("leaving frees the seat", !roster(carol).includes("Alice"));
check("host passes to the new seat 0", carol.last("room").hostId === carol.last("room").players[0].id);

// Nothing further should arrive once the room is quiet.
const settled = carol.msgs.length;
await sleep(QUIET_MS);
check("the room stops talking when nothing is happening", carol.msgs.length === settled);

report([alice, bob, carol, dave, eve, nameless, bobAgain, bobTab2]);
