# Progress

Running state of the build, kept current so a fresh session can resume
without re-deriving anything. [`CLAUDE.md`](./CLAUDE.md) holds the stable
brief (rules, architecture decisions, open questions); this file holds
*where we are*.

**Last updated:** 2026-09-30

## Where we are

**Milestone 1 (rooms + presence) is done, deployed and verified live.**

- **Live:** https://shithead-multiplayer.itsgearofroad.workers.dev
  (version `8d897992-beb9-48d5-8a1d-328b9fa20088`)
- Branch `milestone-1-rooms-and-presence`, **not pushed** to
  `gearoidoc/shithead-multiplayer` and not merged to `main`.
- No game logic exists yet. You can create a room, share a 4-character code,
  and see who's seated. That's all.

## Milestones

| # | Milestone | State |
| --- | --- | --- |
| 1 | Scaffold + a room two tabs can join | **done**, deployed |
| 2 | Deal/shuffle in the room server; per-player views | **next** |
| 3 | `canPlayCard`/`handleSpecialCards` server-side, 2 players | not started |
| 4 | 3–4 players: turn direction, 8-reversal, first player, elimination | not started |
| 5 | Room join by code, reconnect handling | partly done, see below |
| 6 | Polish: visuals, mobile, link back to the portfolio | not started |

Milestone 5 came partly free with milestone 1: room codes, `#CODE` invite
links, a `localStorage` player id that reclaims a seat on reload, and a
reconnecting socket with backoff. What's left there is mid-game reconnect
(resuming into a running game, not just a lobby).

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

## Next step, concretely

Milestone 2: move the deal into the room server.

1. Port shuffle + deal from `../gearoidoc.github.io/shithead/game.js`
   (3 down, 3 up, 3 hand per player; remainder is the draw pile),
   generalised to the 2–4 seats in `src/server.ts`.
2. Add game state to the room alongside `seats`, roughly the shape in
   `CLAUDE.md` ("New state needed for N players").
3. Extend the protocol with a per-player view: each client gets **its own
   hand** plus public info for everyone else (up-cards, down-card *counts*,
   waste pile, whose turn). Per-connection sends, not a shared broadcast.
4. A host-only "start game" action to move `phase` from `lobby` to `swap`.
5. Extend `test/presence.test.mjs` (or add a sibling) to assert a client
   never receives another player's hand or any down-card face.

Remaining open question, only relevant at milestone 6: where the client gets
linked from (standalone vs. the portfolio's Projects nav).
