# Shithead Multiplayer — Project Brief

## Context

The portfolio site [gearoidocallaghan.com](https://gearoidocallaghan.com) lives in the repo
`gearoidoc/gearoidoc.github.io` (static GitHub Pages, deployed via
`.github/workflows/deploy.yml`). It hosts a single-player Shithead card game
at `/shithead` — vanilla JS, no framework, no build step:

- `shithead/index.html` — markup
- `shithead/style.css` — styling (dark green table, card stacks, responsive breakpoints)
- `shithead/game.js` (~930 lines) — full game state + rules engine + a simple AI opponent

This is a **new, separate project**: a live online multiplayer version of the
same game for 2-4 human players. It is not a replacement for the existing
single-player page — that stays as-is.

## Decisions already made (don't re-litigate without checking back with the user)

- **Realtime layer: Cloudflare Durable Objects, via PartyServer.**
  One Durable Object instance = one game room, with authoritative game logic
  running server-side in the room's own code (TypeScript), not in the browser.
  Chosen over a self-hosted Node/WebSocket server (more ops burden) and over
  peer-to-peer/WebRTC (can't keep hands hidden from a technical opponent —
  hidden information is core to this game).
  - **Originally this was PartyKit's hosted platform, and that didn't work
    out (2026-09-30).** PartyKit development has moved to `cloudflare/partykit`
    since the acquisition, and its shared `partykit.dev` zone has hit
    Cloudflare's 10,000-custom-domains-per-zone limit, so `partykit deploy`
    cannot provision a hostname for a new project at all. It fails with
    "You have exceeded the limit of 10000 Workers custom domains on zone
    'partykit.dev'", and registers a project whose URL has no DNS record.
    Don't try the hosted PartyKit platform again.
  - The room server now extends `Server` from **`partyserver`** (the
    maintained Cloudflare successor, near-identical API) and deploys with
    **wrangler** to the user's own Cloudflare account, whose zone limits are
    its own. Keep the framework surface thin — it's ~18 lines of
    `src/server.ts` — so this stays portable.
  - The URL namespace for rooms comes from the Durable Object *binding name*
    in `wrangler.jsonc` (`Room`), kebab-cased: `/parties/room/<code>`.
    PartyServer has no `main` party, unlike PartyKit.
- **Repo: brand-new, separate from `gearoidoc.github.io`**
  (`gearoidoc/shithead-multiplayer`). Keep the portfolio repo purely static.
- **Join flow: room code.** No public room list / matchmaking for v1.
- **Up to 4 players per room**, not just 2.
- **No AI opponent in multiplayer rooms for v1** (stretch goal: allow filling
  empty seats with the existing single-player AI later).
- **No chat, spectators, or ranking/ELO for v1.**

## Why the server is authoritative

The whole point of not doing this peer-to-peer: the server holds the full
deck and every player's hand, and only ever sends each client (a) their own
hand, and (b) public info about everyone else (up-cards, down-card *counts*,
waste pile, whose turn it is). No client ever receives data it shouldn't be
able to see. Don't compromise this for convenience later.

## Game rules to port (reference: `../gearoidoc.github.io/shithead/game.js`,
checked out alongside this repo)

These are implemented today for exactly 2 players (`gameState.player` vs
`gameState.ai`) and need generalizing to N players (2-4):

- **Deal**: 3 face-down, 3 face-up, 3 hand cards per player from a shuffled
  52-card deck; remainder is the draw pile.
- **Swap phase**: before play starts, each player may swap hand cards with
  their own face-up cards.
- **First player**: today, `determineFirstPlayer()` walks rank order
  `3,4,5,6,7,8,9,10,J,Q,K,A,2` and picks whoever holds the lowest one in hand
  or up-cards. For N players this needs to compare across all seats, not
  just two.
- **A turn**: play one or more cards of the same rank that are legal on the
  current waste pile top (equal or higher value, or a special card); if you
  can't or won't play, pick up the entire waste pile into your hand instead.
- **Card values**: 2-10 numeric, J=11, Q=12, K=13, A=14.
- **Special cards** (`canPlayCard` / `handleSpecialCards` in `game.js`):
  - **2**: always playable; resets what can follow (anything can be played
    after a 2).
  - **7**: always requires the next play to be 7-or-lower or another special
    card, until someone breaks the chain.
  - **8**: always playable.
    - 2-player rule today: two 8s played together = same player goes again
      (no turn switch). This still applies unchanged with 2 players (there's
      no "direction" to reverse with only 2 seats).
    - **3-4 player rule (CONFIRMED by the user):**
      - A **single 8** reverses turn direction. Play then continues from the
        *current* player, one seat in the new (reversed) direction.
      - **Two 8s played together** on the same turn: the player who played
        them goes again (same as the 2-player rule) — **and turn direction
        does NOT change.** The reversal only happens on a single-8 play, not
        a double.
      - Worked example, seats A→B→C→D (direction = forward):
        - A plays a single 8 → direction flips to reverse → next to play is
          D (A's "previous" neighbour).
        - A plays two 8s together → A goes again immediately → direction
          stays forward → after A's extra turn, play continues to B as
          normal (not D).
      - **Three 8s played together (CONFIRMED by the user, 2026-10-02)**
        act as two 8s then one: go again, then reverse. Net effect: the
        direction flips and play passes one seat in the new direction
        (A plays three 8s → D is next). With only two players still in,
        it simply passes the turn. Four 8s is four of a kind and burns.
  - **10**: always playable; burns the entire waste pile (removed from the
    game) and the same player goes again.
  - **Four of a kind** on top of the waste pile (top 4 cards matching rank,
    doesn't have to be played in one move) burns the pile, same player goes
    again.
  - After a hand/up-card play, redraw from the deck to keep 3 cards in hand
    (not applicable to down-card plays or once the deck is empty).
  - Once a player has 0 hand cards and 0 up-cards, they play blind from
    their face-down cards (revealed only on play; if illegal, they pick up
    the whole pile plus the revealed card).
- **Win condition today**: first player to empty hand + up-cards + down-cards
  (with the draw pile also empty) wins, game ends immediately.
- **Win condition for multiplayer (CONFIRMED by the user): ranked
  elimination.** Play does *not* stop when the first player finishes. Each
  player who empties hand + up-cards + down-cards is out, and their finishing
  position is recorded (1st, 2nd, 3rd...). Play continues with the remaining
  players until only one is left still holding cards — that player is the
  shithead. So with seats A→B→C→D: A finishes (1st) and leaves the table, B/C/D
  play on, C finishes (2nd), D finishes (3rd), B is left holding cards and
  loses. Turn order must close over a finished seat without skipping a beat,
  and with two players left the "next player" is simply the other one.

## New state needed for N players

The existing code hardcodes `gameState.currentPlayer === 'player' ? 'ai' :
'player'` — that won't extend. You'll need something like:

- `players: [{ id, hand, upcards, downcards, connected }]` (2-4 entries)
- `turnDirection: 1 | -1`
- `currentPlayerIndex`
- Turn order must skip disconnected/eliminated seats cleanly rather than
  breaking.

## Non-functional requirements

- **Node 22+ is required** (wrangler refuses to run on anything older). The
  system Node on this machine is 18.19.1 from apt; Node 24 LTS is installed
  via nvm alongside it and pinned in `.nvmrc`. Run `nvm use` before any npm
  script, or node scripts will silently use 18.
- Leave `gearoidoc.github.io/shithead` untouched.
- Visual style: match the existing dark green table look (see
  `shithead/style.css`) for consistency to start; free to evolve later.
- Mobile-responsive from day one — the single-player version needed a
  retrofit for this after the fact, don't repeat that.

## Suggested first milestones

1. ~~Scaffold the new repo + realtime project. A bare room that two browser
   tabs can join and see each other's presence — no game logic yet.~~
   **Done** (milestone 1).
2. ~~Port the deal/shuffle/state model into the room server; render each
   client's own hand plus everyone else's public info only.~~ **Done**
   (milestone 2).
3. ~~Port `canPlayCard`/`handleSpecialCards` server-side for 2 players first;
   validate behavior against the existing single-player game as a reference.~~
   **Done** (milestone 3) — `src/rules.ts`, a pure engine, N-seat from the
   start.
4. ~~Extend to 3-4 players: turn order/direction, the 8-reversal rule (once
   confirmed), N-player first-player determination, win/elimination
   condition.~~ **Done** — landed with milestone 3; 4-player games are in
   `test/play.test.mjs`.
5. ~~Room creation/join via code, reconnect handling.~~ **Done** — plus
   the host removing away players, and "play again" in the same room.
6. Polish: visuals, mobile layout, a link back to the main portfolio site.
   The link back exists (page header); hosting on the portfolio domain is
   the open question below.

## Open questions to resolve with the user (ask before/while building these parts)

1. **Whether to move to a subdomain later.** For now (decided 2026-10-02)
   the portfolio links to the `workers.dev` URL from its Projects section
   and footer. The options and their costs are in
   `PROGRESS.md` ("Putting it on gearoidocallaghan.com"): a Projects card
   linking to the `workers.dev` URL needs nothing new; a subdomain such as
   `shithead.gearoidocallaghan.com` needs the domain's DNS moved from
   Namecheap to Cloudflare (which also moves the `contact@` email
   forwarding). Don't move DNS or edit the portfolio repo without the
   user's go-ahead.

### Resolved — don't re-ask

- **The 8-reversal rule** — confirmed, see the special-cards section above.
- **Three 8s** — confirmed 2026-10-02: two 8s then one, so a reversal. See
  the special-cards section.
- **A player who goes away and doesn't come back** — confirmed 2026-10-02:
  the host can remove them. Implementation choices (removal only of
  *disconnected* players, cards out of play, ranked below everyone, no
  rejoin, host passes to the first connected seat) are in `PROGRESS.md`.
- **Does play continue after the first player finishes?** Yes — ranked
  elimination, last player holding cards is the shithead. See the win
  condition section above.
- **Hosting account** — the user's own Cloudflare account, already
  authenticated for wrangler (`wrangler login`). Live at
  https://shithead-multiplayer.itsgearofroad.workers.dev. (This replaced a
  PartyKit account, which turned out to be unusable — see above.)
