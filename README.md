# Critter Catch

A tiny 2-player monster-catching race that stays fair and responsive on a laggy connection. Two trainers share a field of wandering critters. Walk up to one and throw an orb: Pebblet and Fluffin are worth 1 point, the fast Zappik is worth 3. First to 10 wins.

The game is small on purpose. It exists to show the netcode.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # simulation tests (node:test)
```

Open the page, click **Copy invite link**, and open the link in a second tab or on a second machine.

## How it stays in sync

```
 client (P1)                         server (authority, 30 Hz)                  client (P2)
 ───────────                         ────────────────────────                   ───────────
 sample keys → input #42 ──────────▶ queue → apply one input per tick
 predict locally with step()          move critters, resolve catches
                                      record 1 s of critter history
 ◀──────────── snapshot (15 Hz): positions, scores, lastSeq=42, events ───────────▶
 reconcile: reset to server,                                          interpolate P1 + critters
 replay inputs #43…                                                   ~133 ms in the past
```

| Problem | Technique | Where |
|---|---|---|
| Cheating / desync | **Authoritative server.** Clients send only inputs, never positions. Inputs are validated (axes clamped, bad frames dropped, 512-byte cap) and rate-limited with a token bucket, so flooding inputs can't speed-hack. | `server.js`, `sanitizeInput` / `tickGame` in `shared/sim.js` |
| Your own movement lags by a full round trip | **Client-side prediction.** The browser runs the *same* `step()` function as the server and moves you immediately. | `clientTick` in `public/client.js` |
| Prediction drifts from the truth | **Server reconciliation.** Each snapshot says which input the server last applied (`lastSeq`). The client resets to the server state and replays the newer inputs. Small corrections are smoothed over a few frames rather than snapped. | `onState` |
| Other entities stutter between 15 Hz snapshots | **Entity interpolation.** The other trainer and the critters are drawn ~2 snapshots in the past, lerped between two known states, on a smoothed estimate of the server clock. | `view()` |
| "I was right next to it!" | **Lag compensation.** Every input carries the server tick the player was *looking at*. The server rewinds critter positions to that tick (up to 1 s, clamped so it can't be abused) before checking the catch. | `tryCatch` |
| Both players catch the same critter | **Server decides, client rolls back.** The orb appears instantly (optimistic), but only the server's event awards the point. The loser sees "Too slow!", or "It broke free!" if the server rejected the throw. Who goes first on same-tick ties alternates every tick. | `predictCatch`, `render` |
| Timer drift | **Fixed timestep** on both ends, driven by an accumulator over a real clock instead of trusting `setInterval`. | bottom of `server.js` / `client.js` |

### Netcode lab

The page has a built-in lag simulator. It adds ping and jitter to both directions through an ordered delay queue, matching TCP ordering. It also has toggles for each technique and a "server ghost" showing where the server really has everyone. With 300 ms of ping, switch prediction off to feel raw lag, reconciliation off to see rubber-banding, and interpolation off to see the stutter.

Packet loss isn't simulated, because WebSocket runs over TCP and loss shows up as latency spikes, which the jitter slider covers.

## Layout

```
server.js          static files + WebSocket rooms + 30 Hz loop
shared/sim.js      the game rules, pure and deterministic, imported by server AND browser
shared/sim.test.js determinism, reconciliation replay, input flood, lag-compensated catch
public/            index.html, client.js (netcode + rendering), sprites.js (pixel art)
```

There is one dependency (`ws`) and no build step.

## Deploy (Render, free)

1. Push this folder to a GitHub repo.
2. On Render, choose **New → Web Service**, pick the repo, set Build `npm install` and Start `npm start`. Render provides `PORT`.
3. The free tier sleeps when idle, so the first visit can take up to a minute to wake it.

Rooms live in memory in one process. That's fine for a demo. Running more than one instance would need shared room state or sticky sessions.

## Credits

All art is original. The trainer sprite comes from my portfolio, and the critters were made for this game.
