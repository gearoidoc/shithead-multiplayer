# Progress

Running state of the build, kept current so a fresh session can resume
without re-deriving anything. [`CLAUDE.md`](./CLAUDE.md) holds the stable
brief (rules, architecture decisions, open questions); this file holds
*where we are*.

**Last updated:** 2026-09-30 (milestone 2 in progress)

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

## Milestones

| # | Milestone | State |
| --- | --- | --- |
| 1 | Scaffold + a room two tabs can join | **done**, deployed |
| 2 | Deal/shuffle in the room server; per-player views | **nearly done**, see below |
| 3 | `canPlayCard`/`handleSpecialCards` server-side, 2 players | not started |
| 4 | 3–4 players: turn direction, 8-reversal, first player, elimination | not started |
| 5 | Room join by code, reconnect handling | partly done, see below |
| 6 | Polish: visuals, mobile, link back to the portfolio | not started |

What's done in milestone 2: shuffle and deal (`src/shared/cards.ts`),
per-seat game state on the server, the per-player view protocol, a host-only
start-game action moving `lobby` -> `swap`, and a table screen that renders
it. **What's left: the swap actions themselves** — swapping a hand card with
one of your own face-up cards, and a per-player "ready" that ends the swap
phase.

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
- **2026-09-30 — first-player determination is still open for N players.**
  The single-player version walks rank order `3..A,2` and, when both players
  hold the lowest rank, silently favours the human. With 2-4 seats that tie
  needs a rule; nothing is implemented yet, so milestone 4 must decide it
  (suggestion: lowest seat index wins the tie, which is deterministic and
  matches the old bias toward the "first" player).

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

## Next step, concretely

Finish the swap phase, then milestone 3 (the rules engine).

1. **Swap actions.** Add `{ type: "swap", handIndex, upcardIndex }` and
   `{ type: "ready" }` to the protocol. Server-side, validate the phase and
   the indices, swap within the player's *own* cards only, and track who is
   ready; when every connected player is ready, move `phase` to `playing`.
   Reference: `swapCards()` / `finishSwap()` in
   `../gearoidoc.github.io/shithead/game.js`.
2. Make the cards clickable on the table screen for that: select a hand card,
   then an up-card, to swap. The `.card.selected` style is already carried
   over in the single-player CSS if you want it.
3. Then milestone 3: port `canPlayCard` / `handleSpecialCards` /
   `playCards` / `burnPile` / `pickUpPile` / `drawBackUpToThree`
   server-side for 2 players, validating against the single-player game.
4. Milestone 4 needs a decision on the first-player tie-break (see
   Decisions above) before `determineFirstPlayer` can be generalised.

Remaining open question from the brief, only relevant at milestone 6: where
the client gets linked from (standalone vs. the portfolio's Projects nav).
