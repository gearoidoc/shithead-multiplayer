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

```bash
npm install
npm run dev     # http://127.0.0.1:1999
```

That one command serves both the client and the room server. Open the URL in
two tabs (or two browsers/devices on the same network — `npm run dev` also
prints a LAN address), create a room in one, join with the code in the other.

With the dev server running, in a second terminal:

```bash
npm test        # presence tests against the running dev server
npm run typecheck
```

## Layout

| Path | What it is |
| --- | --- |
| `src/server.ts` | The room server. One PartyKit room instance = one game room. Authoritative. |
| `src/shared/protocol.ts` | The client/server wire protocol, and the written source of truth for message shapes. |
| `public/index.html` | Lobby + room markup. |
| `public/style.css` | Styling, carried over from the single-player table. |
| `public/app.js` | Lobby/presence client. |
| `public/socket.js` | Dependency-free reconnecting WebSocket wrapper for a room. |
| `test/presence.test.mjs` | Presence tests, driven through real WebSocket clients. |

The client is deliberately plain ES modules with no build step, like the
single-player version. Only the server is TypeScript.

## Notes for the next milestone

- Rooms hold state in memory with `hibernate: false`, on the assumption that a
  room lives about as long as one game. Persisting to room storage is the
  escape hatch if games need to outlive an eviction.
- The server only ever sends room contents to sockets that hold a seat — never
  `room.broadcast` to everything connected. Keep it that way once hands exist.
- A seat is keyed by a client-generated player id kept in `localStorage`, so a
  reload reclaims the same seat. In the lobby a dropped socket frees its seat
  outright; mid-game it will be kept and marked `connected: false`.
