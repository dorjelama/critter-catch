// Game rules shared by the server (the authority) and the browser (prediction).
// Pure: no I/O, no clocks, no Math.random, so both sides compute identical results.

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
export const SNAPSHOT_EVERY = 2; // server sends state every 2nd tick (15 Hz); clients interpolate between
export const W = 480;
export const H = 320;
export const PAD = 10;
export const SPEED = 96; // px per second
export const CATCH_RANGE = 26;
export const WIN_SCORE = 10;
export const MATCH_TICKS = 120 * TICK_HZ;
export const HISTORY_TICKS = TICK_HZ; // 1 s of critter positions kept for lag compensation
export const MAX_QUEUE = TICK_HZ; // inputs buffered per player before extras are dropped
export const BURST = 3; // inputs a player may catch up on in one tick after a lag spike
export const MAX_CRITTERS = 5;
export const SPAWN_EVERY = TICK_HZ;

export const KINDS = [
  { name: "Pebblet", points: 1, speed: 18 },
  { name: "Fluffin", points: 1, speed: 30 },
  { name: "Zappik", points: 3, speed: 58 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const axis = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

// Trust boundary: everything a client sends passes through here before it touches game state.
export function sanitizeInput(raw) {
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.seq) || raw.seq < 0) return null;
  return {
    seq: raw.seq,
    dx: axis(Number(raw.dx) || 0),
    dy: axis(Number(raw.dy) || 0),
    catch: raw.catch === true,
    view: Number.isInteger(raw.view) ? raw.view : null,
  };
}

// One tick of trainer movement. The client runs this to predict, the server to decide.
export function step(p, { dx, dy }) {
  const k = dx && dy ? Math.SQRT1_2 : 1;
  return {
    x: clamp(p.x + dx * SPEED * DT * k, PAD, W - PAD),
    y: clamp(p.y + dy * SPEED * DT * k, PAD, H - PAD),
    dir: dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : dy > 0 ? "down" : p.dir,
  };
}

// mulberry32: seeded so a match replays identically in tests.
function rand(g) {
  let t = (g.seed = (g.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function spawn(g) {
  const r = rand(g);
  g.critters.push({
    id: g.nextId++,
    kind: r < 0.15 ? 2 : r < 0.575 ? 0 : 1,
    x: PAD + rand(g) * (W - 2 * PAD),
    y: PAD + rand(g) * (H - 2 * PAD),
    vx: 0,
    vy: 0,
    turn: 0,
  });
}

export function createGame(seed = 1) {
  const g = { tick: 0, seed, nextId: 1, players: {}, critters: [], history: [], events: [], over: null };
  for (let i = 0; i < 3; i++) spawn(g);
  return g;
}

export function addPlayer(g, id) {
  g.players[id] = { x: id === "p1" ? 60 : W - 60, y: H / 2, dir: "down", score: 0, lastSeq: -1, queue: [], budget: BURST };
}

// Lag compensation: critter positions at the tick this client was looking at, clamped to the history window.
function critterPositionsAt(g, view) {
  if (view === null) return null;
  const t = clamp(view, g.tick - HISTORY_TICKS, g.tick - 1);
  return g.history.find((h) => h.t === t)?.pos ?? null;
}

function tryCatch(g, id, p, view) {
  const past = critterPositionsAt(g, view);
  let best = null;
  let bestD = CATCH_RANGE;
  for (const c of g.critters) {
    const seen = past ? past.get(c.id) : c;
    if (!seen) continue; // spawned after what this client saw
    const d = Math.hypot(seen.x - p.x, seen.y - p.y);
    if (d <= bestD) [best, bestD] = [c, d];
  }
  if (!best) return;
  g.critters.splice(g.critters.indexOf(best), 1);
  p.score += KINDS[best.kind].points;
  g.events.push({ type: "catch", by: id, critter: best.id, kind: best.kind });
  if (p.score >= WIN_SCORE) g.over = { winner: id };
}

export function tickGame(g) {
  g.events = [];
  if (g.over) return;
  g.tick++;

  // Alternate who goes first so neither player always wins same-tick catch ties.
  const ids = Object.keys(g.players);
  if (g.tick % 2) ids.reverse();
  for (const id of ids) {
    const p = g.players[id];
    // Token bucket: 1 input per tick on average, small bursts after lag, so flooding can't speed-hack.
    p.budget = Math.min(BURST, p.budget + 1);
    while (p.queue.length && p.budget >= 1 && !g.over) {
      const input = p.queue.shift();
      p.budget--;
      Object.assign(p, step(p, input));
      p.lastSeq = input.seq;
      if (input.catch) tryCatch(g, id, p, input.view);
    }
  }

  for (const c of g.critters) {
    if (--c.turn <= 0) {
      const a = rand(g) * Math.PI * 2;
      const sp = rand(g) < 0.3 ? 0 : KINDS[c.kind].speed;
      c.vx = Math.cos(a) * sp;
      c.vy = Math.sin(a) * sp;
      c.turn = 20 + Math.floor(rand(g) * 40);
    }
    c.x += c.vx * DT;
    c.y += c.vy * DT;
    if (c.x < PAD || c.x > W - PAD) (c.vx = -c.vx), (c.x = clamp(c.x, PAD, W - PAD));
    if (c.y < PAD || c.y > H - PAD) (c.vy = -c.vy), (c.y = clamp(c.y, PAD, H - PAD));
  }
  if (g.tick % SPAWN_EVERY === 0 && g.critters.length < MAX_CRITTERS) spawn(g);

  g.history.push({ t: g.tick, pos: new Map(g.critters.map((c) => [c.id, { x: c.x, y: c.y }])) });
  if (g.history.length > HISTORY_TICKS) g.history.shift();

  if (!g.over && g.tick >= MATCH_TICKS) {
    const [a, b] = Object.entries(g.players);
    g.over = { winner: !b || a[1].score === b[1].score ? null : a[1].score > b[1].score ? a[0] : b[0] };
  }
}

export function snapshot(g) {
  const players = {};
  for (const [id, p] of Object.entries(g.players)) {
    players[id] = { x: p.x, y: p.y, dir: p.dir, score: p.score, lastSeq: p.lastSeq };
  }
  return {
    type: "state",
    t: g.tick,
    players,
    critters: g.critters.map(({ id, kind, x, y }) => ({ id, kind, x, y })),
    left: Math.max(0, Math.ceil((MATCH_TICKS - g.tick) / TICK_HZ)),
    over: g.over,
  };
}
