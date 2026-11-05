import { CATCH_RANGE, H, KINDS, SNAPSHOT_EVERY, TICK_HZ, W, step } from "/shared/sim.js";
import { COLORS, CRITTERS, TRAINERS } from "/sprites.js";

const INTERP_TICKS = SNAPSHOT_EVERY * 2; // draw others ~2 snapshots (133 ms) in the past so there are always two to lerp between
const TICK_MS = 1000 / TICK_HZ;
const $ = (id) => document.getElementById(id);
const canvas = $("game");
const ctx = canvas.getContext("2d");

// ---------- room: the URL is the invite ----------
let room = new URLSearchParams(location.search).get("room")?.toLowerCase() ?? "";
if (!/^[a-z0-9]{4,8}$/.test(room)) {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  room = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => abc[b % abc.length]).join("");
  history.replaceState(null, "", `?room=${room}`);
}

// ---------- netcode lab controls ----------
const opts = { predict: true, reconcile: true, interp: true, ghost: false };
for (const k of Object.keys(opts)) {
  const el = $(k);
  el.checked = opts[k];
  el.onchange = () => (opts[k] = el.checked);
}
const lag = { ping: 0, jitter: 0 };
for (const [k, id] of [["ping", "lagPing"], ["jitter", "lagJitter"]]) {
  $(id).oninput = (e) => ($(`${id}Out`).textContent = lag[k] = Number(e.target.value));
}

// Fake network: hold each message for ping/2 + random jitter, never reordering (a WebSocket is ordered TCP).
function delayLine() {
  let last = 0;
  return (fn) => {
    const now = performance.now();
    last = Math.max(last, now + lag.ping / 2 + Math.random() * lag.jitter);
    if (last <= now) fn();
    else setTimeout(fn, last - now);
  };
}
const outLine = delayLine();
const inLine = delayLine();

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?room=${room}`);
const send = (msg) => outLine(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)));
ws.onmessage = (e) => inLine(() => onMessage(JSON.parse(e.data)));
let roomFull = false;
ws.onclose = () => inLine(() => roomFull || showStatus("Disconnected. Refresh the page to rejoin."));
setInterval(() => send({ type: "ping", t: performance.now() }), 1000);

// ---------- state ----------
let myId = null;
let snaps = []; // recent server snapshots, oldest first
let clockOffset = null; // server tick ≈ now * TICK_HZ / 1000 + clockOffset
let me = null; // predicted local trainer
let pending = []; // inputs sent but not yet acknowledged by the server
let seq = 0;
let rtt = 0;
let err = { x: 0, y: 0 }; // reconciliation error, decayed per frame so small corrections glide
let pendingCatch = null; // optimistic catch waiting for the server's verdict
let catchQueued = false;

const label = (id) => (id === myId ? "You" : id.toUpperCase());
const latest = () => snaps.at(-1);
const serverNow = () => (performance.now() * TICK_HZ) / 1000 + clockOffset;

function showStatus(text, invite = false) {
  $("status").hidden = !text;
  $("statusText").textContent = text ?? "";
  $("copy").hidden = !invite;
}
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $("copy").textContent = "Copied!";
  } catch {
    $("copy").textContent = location.href;
  }
};

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 1800);
}

function resetMatch() {
  snaps = [];
  pending = [];
  me = null;
  clockOffset = null;
  pendingCatch = null;
}

function onMessage(m) {
  if (m.type === "welcome") {
    myId = m.id;
    $("who").innerHTML = `You are <span class="${m.id}">${m.id.toUpperCase()}</span>.`;
  } else if (m.type === "waiting") {
    resetMatch();
    showStatus("Waiting for a second trainer. Send them the invite link.", true);
  } else if (m.type === "full") {
    roomFull = true;
    showStatus("This room already has two trainers. Open the page without ?room= to start your own.");
  } else if (m.type === "pong") {
    rtt = performance.now() - m.t;
    $("rtt").textContent = `ping ${Math.round(rtt)} ms`;
  } else if (m.type === "state") {
    onState(m);
  }
}

function onState(s) {
  if (snaps.length && s.t < latest().t) resetMatch(); // server started a new match

  // Clock sync: smoothed estimate of which server tick it is right now.
  const sample = s.t - (performance.now() * TICK_HZ) / 1000;
  clockOffset = clockOffset === null || Math.abs(sample - clockOffset) > TICK_HZ ? sample : clockOffset + (sample - clockOffset) * 0.1;
  snaps.push(s);
  if (snaps.length > 30) snaps.shift();

  for (const ev of s.events) {
    if (ev.type !== "catch") continue;
    const { name, points } = KINDS[ev.kind];
    if (ev.by === myId) toast(`Gotcha! ${name} caught (+${points})`);
    else if (pendingCatch?.id === ev.critter) toast(`Too slow! ${label(ev.by)} caught that ${name} first.`);
    else toast(`${label(ev.by)} caught a ${name}`);
    if (pendingCatch?.id === ev.critter) pendingCatch = null;
  }

  const ids = Object.keys(s.players);
  $("score").innerHTML = ids.map((id) => `<span class="${id}">${label(id)} ${s.players[id].score}</span>`).join(" · ");
  $("timer").textContent = `${Math.floor(s.left / 60)}:${String(s.left % 60).padStart(2, "0")}`;
  if (s.over) {
    const w = s.over.winner;
    showStatus(`${w ? (w === myId ? "You win!" : `${label(w)} wins!`) : "It's a draw!"} Next round in 5 seconds…`);
  } else showStatus(null);

  const sm = s.players[myId];
  if (!sm) return;
  // Reconciliation: the server has applied everything up to lastSeq. Start from its answer and
  // replay the inputs it hasn't seen yet, so the prediction stays ahead but never drifts.
  pending = pending.filter((i) => i.seq > sm.lastSeq);
  let p = { x: sm.x, y: sm.y, dir: sm.dir };
  if (opts.reconcile) for (const i of pending) p = step(p, i);
  if (me && opts.reconcile) {
    err.x += me.x - p.x;
    err.y += me.y - p.y;
    if (Math.hypot(err.x, err.y) > 40) err = { x: 0, y: 0 }; // too far off to glide: snap
  }
  me = p;
}

// ---------- input ----------
const KEYS = {
  ArrowUp: "up", w: "up", ArrowDown: "down", s: "down",
  ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right",
  " ": "catch", z: "catch", Enter: "catch",
};
const held = new Set();
const keyOf = (e) => KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
addEventListener("keydown", (e) => {
  const k = keyOf(e);
  if (!k || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, button")) return;
  e.preventDefault();
  if (k !== "catch") held.add(k);
  else if (!e.repeat) catchQueued = true;
});
addEventListener("keyup", (e) => held.delete(keyOf(e)));
addEventListener("blur", () => held.clear());
const axis = (neg, pos) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);

// ---------- what the player sees ----------
function view() {
  const s = latest();
  if (!opts.interp || snaps.length < 2) return { t: s.t, players: s.players, critters: s.critters };
  const t = serverNow() - INTERP_TICKS;
  const i = snaps.findIndex((x) => x.t > t);
  if (i === -1) return { t: s.t, players: s.players, critters: s.critters }; // buffer ran dry: hold the newest
  if (i === 0) return { t: snaps[0].t, players: snaps[0].players, critters: snaps[0].critters };
  const a = snaps[i - 1];
  const b = snaps[i];
  const f = (t - a.t) / (b.t - a.t);
  const lerp = (p, q) => (p ? { ...q, x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f } : q);
  const before = new Map(a.critters.map((c) => [c.id, c]));
  const players = {};
  for (const id in b.players) players[id] = lerp(a.players[id], b.players[id]);
  return { t, players, critters: b.critters.map((c) => lerp(before.get(c.id), c)) };
}

const myPos = () => (opts.predict && me ? { x: me.x + err.x, y: me.y + err.y, dir: me.dir } : latest()?.players[myId]);

// Optimistic catch: hide the critter and play the throw now; the server confirms or the critter "breaks free".
function predictCatch(seen) {
  const p = myPos();
  let best = null;
  for (const c of seen.critters) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= CATCH_RANGE && (!best || d < best.d)) best = { id: c.id, x: c.x, y: c.y, d };
  }
  if (best) pendingCatch = { ...best, at: performance.now() };
}

// Fixed-step input + prediction at the same rate the server simulates.
function clientTick() {
  const s = latest();
  if (!s || s.over || !me) return;
  const seen = view();
  const input = {
    type: "input",
    seq: seq++,
    dx: axis("left", "right"),
    dy: axis("up", "down"),
    catch: catchQueued,
    view: Math.min(Math.round(seen.t), s.t), // lag compensation: the tick I'm looking at
  };
  if (catchQueued) predictCatch(seen);
  catchQueued = false;
  pending.push(input);
  if (pending.length > TICK_HZ * 3) pending.shift();
  if (opts.predict) me = step(me, input);
  send(input);
}

// ---------- drawing ----------
const field = document.createElement("canvas");
field.width = W;
field.height = H;
{
  const f = field.getContext("2d");
  f.fillStyle = "#6fbf4f";
  f.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    const x = (i * 97) % W; // cheap deterministic scatter
    const y = (i * 61 + ((i * i) % 37)) % H;
    f.fillStyle = i % 3 ? "#5aa83e" : "#8fd468";
    f.fillRect(x, y, 2, 1);
    f.fillRect(x + 3, y - 1, 1, 2);
  }
}

const walk = {}; // id -> { x, y, moving }
function drawTrainer(id, p, now, alpha = 1) {
  const w = (walk[id + alpha] ??= { x: p.x, y: p.y, until: 0 });
  if (Math.hypot(p.x - w.x, p.y - w.y) > 0.05) w.until = now + 120;
  w.x = p.x;
  w.y = p.y;
  const frame = now < w.until ? 1 + (Math.floor(now / 150) % 2) : 0;
  ctx.globalAlpha = alpha;
  ctx.drawImage(TRAINERS[id][p.dir][frame], Math.round(p.x - 8), Math.round(p.y - 14));
  ctx.globalAlpha = 1;
  if (alpha === 1) {
    ctx.fillStyle = COLORS[id];
    ctx.fillRect(Math.round(p.x - 3), Math.round(p.y - 18), 6, 2);
  }
}

function drawOrb(x, y, now) {
  const wobble = Math.sin(now / 60) * 1.5;
  ctx.beginPath();
  ctx.arc(x + wobble, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#f4f4f4";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + wobble, y, 5, Math.PI, 0);
  ctx.fillStyle = "#e0303c";
  ctx.fill();
  ctx.strokeStyle = "#1b1b2f";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function render(now) {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(field, 0, 0);
  const s = latest();
  if (!s) return;
  const seen = view();

  if (pendingCatch && now - pendingCatch.at > rtt + lag.jitter * 2 + 250) {
    toast("Oh no! It broke free!"); // server said no: roll the optimistic catch back
    pendingCatch = null;
  }

  const sprites = [];
  for (const c of seen.critters) {
    if (c.id === pendingCatch?.id) continue;
    const bob = Math.round(Math.sin(now / 200 + c.id) * 1);
    sprites.push({ y: c.y, draw: () => ctx.drawImage(CRITTERS[c.kind], Math.round(c.x - 6), Math.round(c.y - 8 + bob)) });
  }
  for (const id in seen.players) {
    const p = id === myId ? myPos() : seen.players[id];
    if (p) sprites.push({ y: p.y, draw: () => drawTrainer(id, p, now) });
  }
  sprites.sort((a, b) => a.y - b.y).forEach((sp) => sp.draw());

  if (opts.ghost) for (const id in s.players) drawTrainer(id, s.players[id], now, 0.4);
  if (pendingCatch) drawOrb(pendingCatch.x, pendingCatch.y, now);
}

let acc = 0;
let last = performance.now();
function frame(now) {
  acc = Math.min(acc + now - last, 250);
  last = now;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    clientTick();
  }
  err.x *= 0.8;
  err.y *= 0.8;
  render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
