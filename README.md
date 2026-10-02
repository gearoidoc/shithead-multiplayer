# Shithead Multiplayer

Live online multiplayer version of [Shithead](https://gearoidocallaghan.com/shithead/)
(2–4 players), the card game hosted as a single-player-vs-AI experience on
[gearoidocallaghan.com](https://gearoidocallaghan.com).

See [`CLAUDE.md`](./CLAUDE.md) for the full project brief: architecture
decisions, the rules, open questions, and milestones, and
[`PROGRESS.md`](./PROGRESS.md) for where the build currently stands.

## Status

**Playable**, live at
[shithead-multiplayer.itsgearofroad.workers.dev](https://shithead-multiplayer.itsgearofroad.workers.dev).
Create a room, share the code or invite link, and play a full game for 2–4
players: the swap phase, every special card, blind face-down plays, and
ranked elimination down to the shithead. The host can remove players who've
gone away, and start another game in the same room when one ends.

The server is authoritative: it holds the deck and every hand, and each
player only ever receives their own hand plus what's public at the table.

## Running it

Needs **Node 22+** (wrangler won't run on less). The repo pins Node 24 in
`.nvmrc`:

```bash
nvm use         # or: nvm install 24, first time
npm install
npm run dev     # http://127.0.0.1:8787
```

That one command serves both the client and the room server. Open the URL in
two tabs — one of them private, so they're different players — create a room
in one, and join with the code in the other. (`npx wrangler dev --ip 0.0.0.0`
makes it reachable from a phone on the same wifi.)

With the dev server running, in a second terminal:

```bash
npm test                   # every suite, against the running dev server
npm run typecheck
node test/rules.test.mjs   # just the rules — needs no server at all

# the same suites against the deployment:
PARTY_HOST=shithead-multiplayer.itsgearofroad.workers.dev npm test
```

## Deploying

```bash
npx wrangler login     # one-off, opens a browser
npm run deploy         # -> shithead-multiplayer.<subdomain>.workers.dev
```

Run `npm run types` after changing `wrangler.jsonc` to regenerate
`worker-configuration.d.ts`, and `npx wrangler tail` to stream live logs from
the deployed rooms. A deploy restarts every room, so games in progress are
lost — rooms hold their state in memory.

## Layout

| Path | What it is |
| --- | --- |
| `src/server.ts` | The room server. One Durable Object instance = one game room. Authoritative. |
| `src/rules.ts` | The rules engine: a pure module, no sockets, ported from the single-player `game.js`. |
| `src/shared/cards.ts` | Cards, the CSPRNG shuffle, and the deal. |
| `src/shared/protocol.ts` | The client/server wire protocol, and the written source of truth for message shapes. |
| `public/index.html` | Lobby, room and table markup. |
| `public/style.css` | Styling, carried over from the single-player table. |
| `public/app.js` | The client. Renders what the server sends; decides nothing. |
| `public/socket.js` | Dependency-free reconnecting WebSocket wrapper for a room. |
| `test/rules.test.mjs` | The rules, deterministically — including a cross-check against the single-player `game.js`. |
| `test/*.test.mjs` | Everything else, driven through real WebSocket clients: presence, the deal and hidden information, swapping, whole games, removing players. |
| `wrangler.jsonc` | Worker config: the Durable Object binding, and `public/` as static assets. |

The client is deliberately plain ES modules with no build step, like the
single-player version. Only the server is TypeScript.
