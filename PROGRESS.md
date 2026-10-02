# Progress

Running state of the build, kept current so a fresh session can resume
without re-deriving anything. [`CLAUDE.md`](./CLAUDE.md) holds the stable
brief (rules, architecture decisions, open questions); this file holds
*where we are*.

**Last updated:** 2026-10-02. Milestone 3 done locally — **not committed,
not deployed**. Most of milestone 4 came with it.

## Where we are

- **Live:** https://shithead-multiplayer.itsgearofroad.workers.dev — still
  **milestone 2** (deal + swap, nothing playable). `npm run deploy` pushes
  the milestone 3 work once it's committed.
- `main` has milestones 1-2 (PR #1 merged). The milestone 3 work is
  uncommitted in the working tree on `main` — branch before committing.
- **A whole game is now playable end to end**: play one or more cards of a
  rank from hand, then up-cards, then blind down-cards; pick up the pile;
  all the special cards; ranked elimination to a shithead; results screen.
- **Tests: 181 passing** across five suites — `rules.test.mjs` (75, pure,
  no server needed), `presence` (23), `game` (31), `swap` (29), `play` (23).
- **Still nobody has watched the UI in a browser.** No browser automation
  was available again (the Claude in Chrome extension isn't connected; only
  Firefox is installed, without a driver). The server and protocol are
  thoroughly tested; `public/app.js` is not. Playing a game in two tabs is
  the first thing to do next session.

## Picking this up again

```bash
cd "Cowork Home/shithead-multiplayer"
nvm use            # Node 24; the system default is 18 and wrangler refuses it
npm install        # only if node_modules is missing
npm run dev        # http://127.0.0.1:8787
npm test           # in a second terminal, also after nvm use
node test/rules.test.mjs   # the rules alone — no dev server needed
```

Open two tabs (one private, so they get different player ids), create a
room in one, join from the other, and play a game through.

## Milestones

| # | Milestone | State |
| --- | --- | --- |
| 1 | Scaffold + a room two tabs can join | **done**, deployed |
| 2 | Deal/shuffle in the room server; per-player views | **done**, deployed |
| 3 | `canPlayCard`/`handleSpecialCards` server-side, 2 players | **done**, not committed or deployed |
| 4 | 3–4 players: turn direction, 8-reversal, first player, elimination | **mostly done** with 3, see below |
| 5 | Room join by code, reconnect handling | partly done, see below |
| 6 | Polish: visuals, mobile, link back to the portfolio | not started |

Milestone 2 in full: shuffle and deal (`src/shared/cards.ts`), per-seat game
state, the per-player view protocol, a host-only start moving `lobby` ->
`swap`, click-to-swap on your own cards, a per-player ready flag that ends
the swap phase, and first-player determination generalised to 2-4 seats.

Milestone 3 in full: the rules engine is `src/rules.ts`, a pure module (no
sockets, no PartyServer) ported from `game.js`. The room server just routes
moves into `applyMove()` and broadcasts the result. Its `canPlayCard` is
checked against the single-player original *itself* — `rules.test.mjs`
extracts the functions from `../gearoidoc.github.io/shithead/game.js` and
compares all 182 (card, top) pairs.

Milestone 4 mostly came with it, because writing a 2-player-only turn switch
would have meant rewriting it: turn order walks `turnDirection` and closes
over finished seats, the single-8 reversal and double-8 go-again are in
(CLAUDE.md's worked example is a test), and ranked elimination runs to a
shithead. `play.test.mjs` plays full 2- and 3-player games over sockets.
What milestone 4 still lacks: a 4-player socket game in the tests (the
rules suite covers 4 seats), and **what happens when the current player is
disconnected** — today the table just waits for them (overlaps milestone 5).

Milestone 5 came largely free: room codes, `#CODE` invite links, a
`localStorage` player id that reclaims a seat, a reconnecting socket with
backoff, and — as of milestone 2 — mid-game reconnect, which returns the
player to their seat with the same hand and is covered by a test. What's left
there is deciding what happens when a player never comes back.

## How to run it

**Node 22+ is required and this machine's default is Node 18.** Node 24 LTS is
installed via nvm and pinned in `.nvmrc`. Forgetting `nvm use` means npm
scripts silently run on 18 — wrangler then refuses outright, and `npm test`
fails in confusing ways.

```bash
nvm use            # ALWAYS FIRST
npm install
npm run dev        # http://127.0.0.1:8787 — serves client AND room server
```

Then, in a second terminal (`nvm use` there too):

```bash
npm test           # 21 presence tests against the running dev server
npm run typecheck

# or run the same suite against the deployment:
PARTY_HOST=shithead-multiplayer.itsgearofroad.workers.dev npm test
```

Deploying: `npm run deploy`. Already authenticated via `wrangler login`
(OAuth, stored in `~/.config/.wrangler/`). Run `npm run types` after editing
`wrangler.jsonc`, and `npx wrangler tail` for live logs from deployed rooms.

## Decisions made while building (not in the original brief)

- **2026-09-30 — PartyKit's hosted platform is a dead end, we're on
  Cloudflare directly.** `partykit deploy` fails with "You have exceeded the
  limit of 10000 Workers custom domains on zone 'partykit.dev'" — the shared
  zone is full, so no new project can get a hostname. It half-registers a
  project whose URL has no DNS. The room server now extends `Server` from
  `partyserver` and deploys with wrangler to the user's own Cloudflare
  account. Don't revisit hosted PartyKit. Full detail in `CLAUDE.md`.
- **2026-09-30 — win condition: ranked elimination.** Play continues after
  the first player finishes; last player holding cards is the shithead.
  Confirmed by the user. Detail in `CLAUDE.md`.
- **2026-09-30 — `worker-configuration.d.ts` is generated but committed**, so
  a fresh clone can typecheck without Cloudflare credentials. It's 16k lines
  and will dominate any diff that regenerates it.
- **2026-09-30 — the shuffle uses `crypto.getRandomValues`, not
  `Math.random()`** (which is what the single-player game uses). The server
  is the trusted dealer for players who can't see each other's cards, so it
  shuffles with the CSPRNG, with rejection sampling to avoid modulo bias.
- **2026-09-30 — errors carry a `fatal` flag.** "You can't be in this room"
  (room full, game already started, no name) closes the socket; a rejected
  action (not the host, not enough players) leaves the player in place with a
  message. The client branches on the flag rather than knowing the codes.
- **2026-09-30 — first-player tie-break: the earliest seat wins. ASSUMED,
  NOT CONFIRMED BY THE USER.** Whoever holds the lowest card by `3..K,A,2`
  across hand and up-cards leads; when several players hold that rank, the
  lowest seat index wins. The single-player version had the same bias (it
  checked the human before the AI) and this keeps it deterministic. It was
  raised with the user and implemented under the stated assumption so the
  swap phase could end in something coherent — **if the house rule differs,
  it's the one `find` in `determineFirstPlayer()` in `src/server.ts`.**
- **2026-09-30 — swapping after readying un-readies you**, rather than being
  refused. Changing your mind is the more forgiving behaviour and costs
  nothing, since the phase ends the moment everyone is ready anyway.
- **2026-09-30 — disconnected players aren't waited on to end the swap
  phase.** Otherwise one dropped player stalls the table indefinitely.

- **2026-10-02 — three 8s together neither reverses nor goes again.
  ASSUMED, NOT CONFIRMED.** The confirmed rules cover a single 8 (reverse)
  and two 8s (go again); the single-player game only singles out exactly
  two. Three 8s is a plain play. Four 8s is four of a kind, so it burns.
- **2026-10-02 — a single 8 that completes four of a kind burns rather than
  reversing**, the same precedence the single-player game uses (it checks
  four of a kind first).
- **2026-10-02 — a single 8 doesn't reverse with only two players left in**
  a 3-4 player game: with two left the next player is the other one either
  way, matching the brief's "no direction to reverse with only 2 seats".
- **2026-10-02 — going out on a 10, four of a kind or two 8s doesn't earn
  another turn** (there's nothing left to play); play passes on. The
  single-player game only checked for a win in `switchTurn`, so a player
  going out on a burn wasn't declared the winner until later — a bug, not
  a rule, and not ported.
- **2026-10-02 — a failed blind play puts the revealed card in your hand**
  along with the pile, per CLAUDE.md. The single-player game left the card
  face down in place, which was a bug.
- **2026-10-02 — players may pick up the pile even with a legal play
  available** ("can't or won't play"), but not an empty pile.
- **2026-10-02 — plays name cards by identity (`{rank, suit}`), not index.**
  A stale client view can't then play the wrong card; the server checks each
  named card is held, in the zone the player must play from. Swaps still
  use indices (milestone 2, swap phase only).
- **2026-10-02 — the game can, in principle, loop forever on forced moves**
  (e.g. a player stuck on up-cards that can't beat an 8 picks it up, plays
  it back, and round it goes). Every move is legal; humans break such loops
  and bots can't — about 1 bot game in 900 stalls in simulation. There's no
  stalemate rule in `game.js` or the brief, so none was invented;
  `play.test.mjs` re-deals a stalled bot game instead. Raise with the user
  if it ever shows up in real play.

## Landmines

- **Never use a blanket `broadcast()`.** It reaches sockets that haven't
  joined or were refused a seat — a refused 5th player was receiving the full
  roster before this was fixed. `broadcastRoom()` walks
  `connectionToPlayer` instead. This matters far more once hands exist, and
  hidden information is the entire reason the server is authoritative.
- **Rooms are at `/parties/room/<code>`.** The `room` segment is the Durable
  Object binding name from `wrangler.jsonc`, kebab-cased — not a free choice.
  PartyServer has no `main` party (PartyKit did); changing the binding name
  changes the client URL.
- **A newly created `workers.dev` subdomain 404s for a minute or two** after
  the first deploy, DNS and all. It isn't a broken deploy; wait and retry.
- `hibernate: false`, so room state lives in memory and dies with the
  instance. Fine while a room lasts one game; Durable Object storage is the
  escape hatch if that stops being true.
- The client is plain ES modules with **no build step** (deliberate, matches
  the single-player version), so it can't import
  `src/shared/protocol.ts`. That file is the written source of truth for
  message shapes — **update `public/app.js` by hand to match.**
- **Never put a `Seat` on the wire by spreading it.** A `Seat` holds `hand`,
  `upcards` and `downcards`. Everything client-bound is built field by field
  by `publicPlayer()` and `seatView()` in `src/server.ts` precisely so that
  adding a field to `Seat` can't silently leak it. `test/game.test.mjs`
  walks every message a client received and asserts it contains no card it
  isn't entitled to — keep that test honest as the game grows.
- **Don't name a method `broadcast`.** PartyServer's own `broadcast()` sends
  to every connected socket, including sockets with no seat; TypeScript
  catches the collision, which is how `broadcastState()` got its name. The
  game view is per-connection anyway, since each player's hand differs.
- **A player can't join a game in progress** — a seat that wasn't dealt in
  has no cards. Newcomers are refused with `game-in-progress`; a known
  player id takes the reconnect path and keeps its seat.
- **Leaving mid-game doesn't free the seat**, because renumbering would
  reshuffle a live table's seating order. It degrades to the same handling
  as a dropped socket.
- **No fixed sleeps in tests.** `test/harness.mjs` waits on conditions
  (`waitFor`, `waitForType`, `waitForNext`) because fixed delays pass
  locally and then fail against a deployment, where a round trip is an order
  of magnitude slower. That actually happened: the suite scored 13/31 against
  the live URL right after a deploy and passed on a retry, which is the worst
  kind of test failure. Use `QUIET_MS` only for asserting that nothing
  *further* arrives.
- **`src/rules.ts` and `src/shared/cards.ts` must stay loadable by plain
  Node** (`rules.test.mjs` imports them directly with Node 24's type
  stripping): keep the `.ts` extension on their relative imports
  (`allowImportingTsExtensions` is on), and don't use TS-only syntax that
  emits code — no `enum`, `namespace` or constructor parameter properties.
  `package.json` is `"type": "module"` for the same reason.
- **The client has its own copy of `canPlay`** in `public/app.js`, for
  highlighting only. If the rule changes in `rules.ts`, change it there too
  — a mismatch just means a refused move, never a cheat.
- **`[hidden]` needs `display: none !important`** in `style.css`, because
  the screens set `display: flex` by id, which beats the browser's own
  `hidden` rule. Without it the table bar was showing on the lobby screen.
- **Client-side card indices are only valid against the state they came
  from.** Swap messages carry `handIndex`/`upcardIndex`, so the selection is
  cleared whenever a new game view arrives. The server validates bounds and
  integer-ness regardless — it never trusts an index.

## Next step, concretely

1. **Play a game in two browser tabs** and fix whatever the UI gets wrong —
   it has never been looked at. Then try three tabs, and a phone-width
   window.
2. Commit on a branch (`milestone-3-play`), open a PR, merge, `npm run
   deploy`, and run the suite against the deployment
   (`PARTY_HOST=shithead-multiplayer.itsgearofroad.workers.dev npm test`).
3. Finish milestone 4: a 4-player game in `play.test.mjs`; confirm the
   three-8s assumption with the user.
4. Milestone 5's remaining question, now urgent because play exists: what
   happens when the **current** player disconnects and doesn't come back?
   The table waits forever today. Options to put to the user: skip their
   turns while away, a timeout, or the host can remove them.
5. A "play again" in the same room — today you leave and make a new room.

Remaining open question from the brief, only relevant at milestone 6: where
the client gets linked from (standalone vs. the portfolio's Projects nav).
