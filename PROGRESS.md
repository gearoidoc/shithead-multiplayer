# Progress

Running state of the build, kept current so a fresh session can resume
without re-deriving anything. [`CLAUDE.md`](./CLAUDE.md) holds the stable
brief (rules, architecture decisions, open questions); this file holds
*where we are*.

**Last updated:** 2026-09-30, end of session. Milestones 1-2 done and on
`main`; milestone 3 not started.

## Where we are

**Milestone 1 done, deployed, verified live. Milestone 2 mostly done, not yet
deployed.**

- **Live:** https://shithead-multiplayer.itsgearofroad.workers.dev
  — this is still **milestone 1** (lobby only). Milestone 2 is committed but
  not deployed; run `npm run deploy` to push it live.
- Branch `milestone-1-rooms-and-presence`, pushed to
  `gearoidoc/shithead-multiplayer`. **Not merged to `main`**, and there's no
  PR open yet.
- A game can now be dealt. The host starts, everyone gets their own hand plus
  public information about everyone else, and the table renders. Nothing is
  clickable yet — no card can be played, and cards can't be swapped.
- **Tests: 52 passing** — 21 presence (`test/presence.test.mjs`), 31 deal and
  hidden-information (`test/game.test.mjs`).

## Picking this up again

```bash
cd "Cowork Home/shithead-multiplayer"
nvm use            # Node 24; the system default is 18 and wrangler refuses it
npm install        # only if node_modules is missing
npm run dev        # http://127.0.0.1:8787
npm test           # in a second terminal, also after nvm use
```

Everything is committed and pushed, nothing is half-finished, and the live
deployment matches `main`. The next piece of work is **milestone 3**, planned
step by step at the bottom of this file.

Two things were left deliberately unverified or undecided, both noted in full
below: **nobody has watched the table UI in a browser** (no browser
automation was available), and the **first-player tie-break is an assumption,
not your decision** — earliest seat wins when players tie on the lowest card.

## Milestones

| # | Milestone | State |
| --- | --- | --- |
| 1 | Scaffold + a room two tabs can join | **done**, deployed |
| 2 | Deal/shuffle in the room server; per-player views | **done**, deployed |
| 3 | `canPlayCard`/`handleSpecialCards` server-side, 2 players | **next** |
| 4 | 3–4 players: turn direction, 8-reversal, first player, elimination | not started |
| 5 | Room join by code, reconnect handling | partly done, see below |
| 6 | Polish: visuals, mobile, link back to the portfolio | not started |

Milestone 2 in full: shuffle and deal (`src/shared/cards.ts`), per-seat game
state, the per-player view protocol, a host-only start moving `lobby` ->
`swap`, click-to-swap on your own cards, a per-player ready flag that ends
the swap phase, and first-player determination generalised to 2-4 seats.

Milestone 4's turn-order work is partly done as a side effect: the room
carries `currentPlayerId` and `turnDirection`, and `determineFirstPlayer()`
already handles any number of seats. What milestone 4 still owns is advancing
the turn, the single-8 reversal, and elimination.

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
- **Client-side card indices are only valid against the state they came
  from.** Swap messages carry `handIndex`/`upcardIndex`, so the selection is
  cleared whenever a new game view arrives. The server validates bounds and
  integer-ness regardless — it never trusts an index.

## Next step, concretely

Milestone 3: the rules engine, server-side, validated against the
single-player game with 2 players before going to 3-4.

1. Port from `../gearoidoc.github.io/shithead/game.js`, in roughly this
   order: `getTopCard`, `isUnder7Rule`, `isSpecialRank`, `canPlayCard`,
   then `playCards`, `handleSpecialCards`, `isFourOfAKind`, `burnPile`,
   `pickUpPile`, `drawBackUpToThree`, `checkWinCondition`.
2. Add the play actions to the protocol: playing one or more cards of the
   same rank from hand, up-cards or (blind) down-cards, and picking up the
   pile. The server must validate the source as well as the cards — a client
   asking to play from its down-cards while it still holds a hand is
   cheating, not a UI bug.
3. Special cards, from `CLAUDE.md`: 2 resets, 7 forces the next play low,
   8 is always playable, 10 burns the pile and goes again, four-of-a-kind on
   top burns. The 8-reversal is 3-4 player behaviour, so it belongs with
   milestone 4, but leave room for it.
4. Extend the test suites the same way: a `play.test.mjs` sibling, and keep
   asserting the hidden-information properties after every new action — a
   down-card play is the first time a card becomes public, so it's the most
   likely place to leak one early.
5. Elimination and ranking (`CLAUDE.md`, confirmed: last player holding
   cards is the shithead) lands with milestone 4's turn order.

Remaining open question from the brief, only relevant at milestone 6: where
the client gets linked from (standalone vs. the portfolio's Projects nav).
