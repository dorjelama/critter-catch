// Authoritative game server: serves the client files and runs every room's simulation at TICK_HZ.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { MAX_QUEUE, SNAPSHOT_EVERY, TICK_HZ, addPlayer, createGame, sanitizeInput, snapshot, tickGame } from "./shared/sim.js";

const PORT = Number(process.env.PORT) || 3000;
const RESTART_TICKS = 5 * TICK_HZ;

// Whitelist instead of a path join: nothing outside these files can be requested.
const FILES = {
  "/": ["public/index.html", "text/html"],
  "/client.js": ["public/client.js", "text/javascript"],
  "/sprites.js": ["public/sprites.js", "text/javascript"],
  "/shared/sim.js": ["shared/sim.js", "text/javascript"],
};

const server = http.createServer(async (req, res) => {
  const file = FILES[new URL(req.url, "http://x").pathname];
  if (!file) return res.writeHead(404).end("Not found");
  try {
    res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` }).end(await readFile(new URL(file[0], import.meta.url)));
  } catch {
    res.writeHead(500).end();
  }
});

// shortcut: rooms live in this process's memory; move to Redis/sticky sessions only if it ever runs on >1 instance.
const rooms = new Map();
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 });

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (room, msg) => room.sockets.forEach((ws) => send(ws, msg));

function startMatch(room) {
  room.game = createGame((Math.random() * 2 ** 32) >>> 0);
  for (const id of room.sockets.keys()) addPlayer(room.game, id);
  room.events = [];
  room.overTicks = 0;
}

wss.on("connection", (ws, req) => {
  const code = new URL(req.url, "http://x").searchParams.get("room")?.toLowerCase() ?? "";
  if (!/^[a-z0-9]{4,8}$/.test(code)) return ws.close(1008, "bad room");

  const room = rooms.get(code) ?? { code, sockets: new Map(), game: null };
  rooms.set(code, room);
  const id = ["p1", "p2"].find((p) => !room.sockets.has(p));
  if (!id) {
    send(ws, { type: "full" });
    return ws.close();
  }
  room.sockets.set(id, ws);
  send(ws, { type: "welcome", id });
  if (room.sockets.size === 2) startMatch(room);
  else send(ws, { type: "waiting" });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.type === "ping" && typeof msg.t === "number") return send(ws, { type: "pong", t: msg.t });
    const player = room.game?.players[id];
    const input = msg?.type === "input" && sanitizeInput(msg);
    if (player && input && player.queue.length < MAX_QUEUE) player.queue.push(input);
  });

  ws.on("close", () => {
    room.sockets.delete(id);
    room.game = null;
    if (room.sockets.size) broadcast(room, { type: "waiting" });
    else rooms.delete(code);
  });
});

function tickRoom(room) {
  const g = room.game;
  if (!g) return;
  if (g.over) {
    if (++room.overTicks >= RESTART_TICKS) startMatch(room);
    return;
  }
  tickGame(g);
  room.events.push(...g.events);
  if (g.tick % SNAPSHOT_EVERY === 0 || g.over) {
    broadcast(room, { ...snapshot(g), events: room.events });
    room.events = [];
  }
}

// Fixed timestep from a real clock: setInterval drifts, the accumulator keeps exactly TICK_HZ on average.
const TICK_MS = 1000 / TICK_HZ;
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + now - last, 250); // after a stall, skip ahead instead of fast-forwarding seconds
  last = now;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    rooms.forEach(tickRoom);
  }
}, TICK_MS / 2);

server.listen(PORT, () => console.log(`Critter Catch on http://localhost:${PORT}`));
