import { test } from "node:test";
import assert from "node:assert/strict";
import { BURST, HISTORY_TICKS, W, addPlayer, createGame, sanitizeInput, step, tickGame } from "./sim.js";

const input = (seq, dx = 1, dy = 0, extra = {}) => ({ seq, dx, dy, catch: false, view: null, ...extra });

test("sanitizeInput clamps axes and rejects junk", () => {
  assert.deepEqual(sanitizeInput({ seq: 3, dx: 99, dy: -0.2, catch: "yes" }), { seq: 3, dx: 1, dy: -1, catch: false, view: null });
  assert.equal(sanitizeInput({ seq: "1" }), null);
  assert.equal(sanitizeInput({ seq: -1 }), null);
  assert.equal(sanitizeInput(null), null);
  assert.equal(sanitizeInput({ seq: 0, dx: "abc" }).dx, 0);
});

test("step is deterministic, normalises diagonals and stays in bounds", () => {
  const a = step({ x: 100, y: 100, dir: "down" }, input(0, 1, 1));
  assert.deepEqual(a, step({ x: 100, y: 100, dir: "down" }, input(0, 1, 1)));
  assert.ok(Math.abs(Math.hypot(a.x - 100, a.y - 100) - 96 / 30) < 1e-9);
  let p = { x: W - 11, y: 100, dir: "down" };
  for (let i = 0; i < 10; i++) p = step(p, input(i));
  assert.equal(p.x, W - 10);
  assert.equal(p.dir, "right");
});

test("reconciliation: server state + replayed unacked inputs equals full local prediction", () => {
  const inputs = Array.from({ length: 10 }, (_, i) => input(i, i % 3 - 1, i % 2));
  const start = { x: 200, y: 150, dir: "down" };
  const predicted = inputs.reduce(step, start);

  const g = createGame(7);
  addPlayer(g, "p1");
  Object.assign(g.players.p1, start);
  g.players.p1.queue.push(...inputs.slice(0, 6));
  for (let i = 0; i < 6; i++) tickGame(g); // server acks seq 0..5
  const server = g.players.p1;
  assert.equal(server.lastSeq, 5);
  const replayed = inputs.filter((i) => i.seq > server.lastSeq).reduce(step, server);
  assert.equal(replayed.x, predicted.x);
  assert.equal(replayed.y, predicted.y);
});

test("input flood cannot move a player faster than one input per tick", () => {
  const g = createGame(1);
  addPlayer(g, "p1");
  g.players.p1.queue.push(...Array.from({ length: 30 }, (_, i) => input(i)));
  tickGame(g);
  assert.equal(g.players.p1.lastSeq, BURST - 1); // one catch-up burst...
  for (let i = 0; i < 10; i++) tickGame(g);
  assert.equal(g.players.p1.lastSeq, BURST - 1 + 10); // ...then strictly one input per tick
});

test("lag compensation: a catch hits where the client saw the critter, not where it is now", () => {
  const setup = () => {
    const g = createGame(3);
    g.critters = [{ id: 1, kind: 0, x: 100, y: 100, vx: 0, vy: 0, turn: 1e9 }];
    addPlayer(g, "p1");
    Object.assign(g.players.p1, { x: 100, y: 120 });
    tickGame(g); // history: critter at (100,100) on tick 1
    g.critters[0].x = 300; // it has since wandered off
    for (let i = 0; i < 5; i++) tickGame(g);
    return g;
  };

  const old = setup();
  old.players.p1.queue.push(input(0, 0, 0, { catch: true, view: 1 }));
  tickGame(old);
  assert.equal(old.players.p1.score, 1);
  assert.equal(old.critters.length, 0);

  const now = setup();
  now.players.p1.queue.push(input(0, 0, 0, { catch: true, view: now.tick }));
  tickGame(now);
  assert.equal(now.players.p1.score, 0);

  const ancient = setup(); // claims beyond the window are clamped, not trusted
  for (let i = 0; i < HISTORY_TICKS; i++) tickGame(ancient);
  ancient.players.p1.queue.push(input(0, 0, 0, { catch: true, view: 1 }));
  tickGame(ancient);
  assert.equal(ancient.players.p1.score, 0);
});

test("same seed replays the same match", () => {
  const run = () => {
    const g = createGame(42);
    for (let i = 0; i < 300; i++) tickGame(g);
    return JSON.stringify(g.critters);
  };
  assert.equal(run(), run());
});
