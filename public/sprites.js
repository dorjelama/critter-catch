// Original pixel art as string grids: one char per pixel, "." is transparent.
// The trainer is the same sprite as the portfolio (portfolio/src/game/sprites.js), recoloured per player.
const PALETTE = {
  k: "#1b1b2f", // outline
  n: "#2b2f77", // beanie
  N: "#4a52b3", // beanie cuff
  w: "#ffffff",
  h: "#1a1a1a", // hair
  s: "#f2c29b", // skin
  S: "#d99b73",
  e: "#1a1a1a", // eyes
  t: "#1f9e9a", // scarf
  o: "#e0a43a", // scarf stripe
  j: "#2a2a2a", // jacket
  b: "#4a3424", // trousers / boots
  R: "#a3a9b0", // Pebblet
  r: "#6b7177",
  P: "#f4a7c4", // Fluffin
  p: "#d9739c",
  Y: "#ffd23f", // Zappik
  y: "#d99a1e",
  c: "#ff6b4a",
};
const P2 = { n: "#7a1f2b", N: "#b33a4a", t: "#e0a43a", o: "#1f9e9a" };

const HEAD_FRONT = [
  "....kkkkkkkk....",
  "...knnnnNNnnk...",
  "..knnnnnnwnnnk..",
  "..kNNNNNNNNNNk..",
  "..khhhhhhhhhhk..",
  "..khsssssssshk..",
  "..khsesssseshk..",
  "...ksssSSsssk...",
];
const HEAD_BACK = [
  "....kkkkkkkk....",
  "...knnnnNNnnk...",
  "..knnnnnnnnnnk..",
  "..kNNNNNNNNNNk..",
  "..khhhhhhhhhhk..",
  "..khhhhhhhhhhk..",
  "..khhhhhhhhhhk..",
  "...khhhhhhhhk...",
];
const BODY_FRONT = [
  "..kttottttottk..",
  ".kjttttttttttjk.",
  ".kjjjtottotjjjk.",
  ".ksjjjjjjjjjjsk.",
  "..kjjjjjjjjjjk..",
];
const BODY_BACK = [
  "..kttttttttttk..",
  ".kjttttttttttjk.",
  ".kjjjjjjjjjjjjk.",
  ".ksjjjjjjjjjjsk.",
  "..kjjjjjjjjjjk..",
];
const SIDE_TOP = [
  ".....kkkkkkk....",
  "....knnnnNNnk...",
  "...knnnnnnnnnk..",
  "...kNNNNNNNNNk..",
  "...khhhhhhhhhk..",
  "..ksssshhhhhhk..",
  "..ksesshhhhhhk..",
  "...ksssshhhhk...",
  "...kttttttttok..",
  "..kttttjjjjjjk..",
  "...kjjjjjjjjk...",
  "...kjsjjjjjjk...",
  "...kjjjjjjjjk...",
];
const LEGS = {
  stand: ["...kbbbbbbbbk...", "...kbbk..kbbk...", "...kkkk..kkkk..."],
  walk: ["...kbbbbbbbbk...", "..kbbk...kbbk...", "..kkkk....kkk..."],
  sideStand: ["....kbbbbbbk....", "....kbbkkbbk....", "....kkk..kkk...."],
  sideWalk: ["...kbbbbbbbbk...", "..kbbk....kbbk..", "..kkk......kkk.."],
};

const mirror = (rows) => rows.map((r) => [...r].reverse().join(""));
const front = [...HEAD_FRONT, ...BODY_FRONT];
const back = [...HEAD_BACK, ...BODY_BACK];
const left = [
  [...SIDE_TOP, ...LEGS.sideStand],
  [...SIDE_TOP, ...LEGS.sideWalk],
  [...SIDE_TOP, ...LEGS.sideWalk],
];
// TRAINER[dir] = [stand, walkA, walkB]
const TRAINER = {
  down: [[...front, ...LEGS.stand], [...front, ...LEGS.walk], [...front, ...mirror(LEGS.walk)]],
  up: [[...back, ...LEGS.stand], [...back, ...LEGS.walk], [...back, ...mirror(LEGS.walk)]],
  left,
  right: left.map(mirror),
};

// Indexed by kind, matching KINDS in shared/sim.js.
const CRITTER_ART = [
  [
    "............",
    "....kkkk....",
    "..kkRRRRkk..",
    ".kRRRRRRRRk.",
    ".kRwkRRwkRk.",
    "kRRwkRRwkRRk",
    "kRRRRRRRRRrk",
    "kRRRrRRRRrrk",
    "krRRRRRRrrrk",
    ".krrrrrrrrk.",
    "..kkkkkkkk..",
    "............",
  ],
  [
    ".kk......kk.",
    ".kPk....kPk.",
    ".kPPkkkkPPk.",
    "kPPPPPPPPPPk",
    "kPPwkPPwkPPk",
    "kPPwkPPwkPPk",
    "kpPPPPPPPPpk",
    "kpPPPkkPPPpk",
    ".kpPPPPPPpk.",
    ".kppPPPPppk.",
    "..kpkkkkpk..",
    "..kk....kk..",
  ],
  [
    "k..........k",
    "kk........kk",
    "kYk.kkkk.kYk",
    ".kYkYYYYkYk.",
    "..kYYYYYYk..",
    ".kYwkYYwkYk.",
    ".kYwkYYwkYk.",
    ".kcYYkkYYck.",
    ".kYYYYYYYYkk",
    "..kyYYYYykYk",
    "..kykkkkykk.",
    "..kk....kk..",
  ],
];

// Draws a grid to its own canvas once, so the game loop only blits images.
function toCanvas(rows, overrides = {}) {
  const c = document.createElement("canvas");
  c.width = rows[0].length;
  c.height = rows.length;
  const ctx = c.getContext("2d");
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle = overrides[ch] ?? PALETTE[ch];
      ctx.fillRect(x, y, 1, 1);
    })
  );
  return c;
}

const bake = (overrides) =>
  Object.fromEntries(Object.entries(TRAINER).map(([dir, frames]) => [dir, frames.map((f) => toCanvas(f, overrides))]));

export const TRAINERS = { p1: bake({}), p2: bake(P2) };
export const CRITTERS = CRITTER_ART.map((rows) => toCanvas(rows));
export const COLORS = { p1: PALETTE.t, p2: P2.n };
