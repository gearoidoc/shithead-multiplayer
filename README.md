# Shithead Multiplayer

Live online multiplayer version of [Shithead](https://gearoidocallaghan.com/shithead/)
(2–4 players), the card game hosted as a single-player-vs-AI experience on
[gearoidocallaghan.com](https://gearoidocallaghan.com).

See [`CLAUDE.md`](./CLAUDE.md) for the full project brief: architecture
decisions, the rules to port, open questions, and milestones.

## Status

**Milestone 1 done: rooms and presence.** No game logic yet — you can create a
room, share the code, and watch players come and go.

## Running it

Needs **Node 22+** (wrangler won't run on less). The repo pins Node 24 in
`.nvmrc`:

```bash
nvm use         # or: nvm install 24, first time
npm install
npm run dev     # http://127.0.0.1:8787
```

That one command serves both the client and the room server. Open the URL in
two tabs (wrangler also accepts `--ip 0.0.0.0` if you want to reach it from a
phone on the same wifi), create a room in one, join with the code in the other.

With the dev server running, in a second terminal:

```bash
npm test           # presence tests against the running dev server
npm run typecheck
```

## Deploying

```bash
npx wrangler login     # one-off, opens a browser
npm run deploy         # -> shithead-multiplayer.<subdomain>.workers.dev
```

Run `npm run types` after changing `wrangler.jsonc` to regenerate
`worker-configuration.d.ts`, and `npx wrangler tail` to stream live logs from
the deployed rooms.

## Layout

| Path | What it is |
| --- | --- |
| `src/server.ts` | The room server. One Durable Object instance = one game room. Authoritative. |
| `src/shared/protocol.ts` | The client/server wire protocol, and the written source of truth for message shapes. |
| `public/index.html` | Lobby + room markup. |
| `public/style.css` | Styling, carried over from the single-player table. |
| `public/app.js` | Lobby/presence client. |
| `public/socket.js` | Dependency-free reconnecting WebSocket wrapper for a room. |
| `test/presence.test.mjs` | Presence tests, driven through real WebSocket clients. |
| `wrangler.jsonc` | Worker config: the Durable Object binding, and `public/` as static assets. |

The client is deliberately plain ES modules with no build step, like the
single-player version. Only the server is TypeScript.

## Notes for the next milestone

- Rooms hold state in memory with `hibernate: false`, on the assumption that a
  room lives about as long as one game. The Durable Object's storage is the
  escape hatch if games need to outlive an eviction.
- The server only ever sends room contents to sockets that hold a seat — never
  a blanket `broadcast()`. Keep it that way once hands exist.
- A seat is keyed by a client-generated player id kept in `localStorage`, so a
  reload reclaims the same seat. In the lobby a dropped socket frees its seat
  outright; mid-game it will be kept and marked `connected: false`.
- Rooms are addressed as `/parties/room/<code>` — the `room` segment is the
  Durable Object binding name from `wrangler.jsonc`, kebab-cased, not a name
  the client picks freely.
