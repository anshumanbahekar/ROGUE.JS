"use strict";

// ---------- Utility ----------
const RNG = (() => {
  let seed = (Date.now() % 2147483647) || 1;
  function next() {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }
  return {
    reseed(s) { seed = (s % 2147483647) || 1; },
    float() { return next(); },
    int(min, max) { return Math.floor(next() * (max - min + 1)) + min; },
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    chance(p) { return next() < p; }
  };
})();

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function key(x, y) { return x + "," + y; }

// ---------- Tile types ----------
const TILE = { WALL: 0, FLOOR: 1, DOOR: 2, STAIRS_DOWN: 3, CHEST: 4, TRAP_HIDDEN: 5, TRAP_REVEALED: 6 };

// ---------- BSP Dungeon Generator ----------
class BSPNode {
  constructor(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.left = null; this.right = null; this.room = null;
  }
  isLeaf() { return !this.left && !this.right; }
  split(minSize) {
    if (!this.isLeaf()) return false;
    const horizontal = RNG.chance(0.5);
    const maxSize = horizontal ? this.h : this.w;
    if (maxSize < minSize * 2 + 2) return false;
    const splitAt = RNG.int(minSize, maxSize - minSize);
    if (horizontal) {
      this.left = new BSPNode(this.x, this.y, this.w, splitAt);
      this.right = new BSPNode(this.x, this.y + splitAt, this.w, this.h - splitAt);
    } else {
      this.left = new BSPNode(this.x, this.y, splitAt, this.h);
      this.right = new BSPNode(this.x + splitAt, this.y, this.w - splitAt, this.h);
    }
    return true;
  }
}

class Dungeon {
  constructor(w, h, depth) {
    this.w = w; this.h = h; this.depth = depth;
    this.tiles = new Array(w * h).fill(TILE.WALL);
    this.rooms = [];
    this.generate();
  }
  idx(x, y) { return y * this.w + x; }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return TILE.WALL;
    return this.tiles[this.idx(x, y)];
  }
  set(x, y, t) { this.tiles[this.idx(x, y)] = t; }
  isWalkable(x, y) {
    const t = this.get(x, y);
    return t === TILE.FLOOR || t === TILE.DOOR || t === TILE.STAIRS_DOWN ||
           t === TILE.CHEST || t === TILE.TRAP_HIDDEN || t === TILE.TRAP_REVEALED;
  }

  generate() {
    const root = new BSPNode(1, 1, this.w - 2, this.h - 2);
    const leaves = [];
    const minSize = 8;
    const queue = [root];
    let iterations = 0;
    while (queue.length && iterations < 200) {
      iterations++;
      const node = queue.shift();
      if (node.w > 20 || node.h > 16 || RNG.chance(0.65)) {
        if (node.split(minSize)) {
          queue.push(node.left, node.right);
          continue;
        }
      }
      leaves.push(node);
    }
    for (const leaf of leaves) this.carveRoom(leaf);
    this.connect(root);
    this.placeFeatures(leaves);
  }

  carveRoom(node) {
    const padX = RNG.int(1, 2), padY = RNG.int(1, 2);
    const rw = Math.max(4, node.w - padX * 2);
    const rh = Math.max(4, node.h - padY * 2);
    const rx = node.x + RNG.int(0, Math.max(0, node.w - rw - 1));
    const ry = node.y + RNG.int(0, Math.max(0, node.h - rh - 1));
    const room = { x: rx, y: ry, w: rw, h: rh,
      cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) };
    for (let y = room.y; y < room.y + room.h; y++)
      for (let x = room.x; x < room.x + room.w; x++)
        this.set(x, y, TILE.FLOOR);
    node.room = room;
    this.rooms.push(room);
  }

  getRoom(node) {
    if (node.room) return node.room;
    const a = node.left ? this.getRoom(node.left) : null;
    const b = node.right ? this.getRoom(node.right) : null;
    return RNG.chance(0.5) ? (a || b) : (b || a);
  }

  connect(node) {
    if (node.isLeaf()) return;
    this.connect(node.left);
    this.connect(node.right);
    const a = this.getRoom(node.left);
    const b = this.getRoom(node.right);
    if (a && b) this.carveCorridor(a, b);
  }

  carveCorridor(a, b) {
    let x = a.cx, y = a.cy;
    const tx = b.cx, ty = b.cy;
    if (RNG.chance(0.5)) {
      while (x !== tx) { this.set(x, y, TILE.FLOOR); x += x < tx ? 1 : -1; }
      while (y !== ty) { this.set(x, y, TILE.FLOOR); y += y < ty ? 1 : -1; }
    } else {
      while (y !== ty) { this.set(x, y, TILE.FLOOR); y += y < ty ? 1 : -1; }
      while (x !== tx) { this.set(x, y, TILE.FLOOR); x += x < tx ? 1 : -1; }
    }
    this.set(tx, ty, TILE.FLOOR);
  }

  placeFeatures(leaves) {
    const last = this.rooms[this.rooms.length - 1];
    this.set(last.cx, last.cy, TILE.STAIRS_DOWN);
    this.stairsPos = { x: last.cx, y: last.cy };
    this.startRoom = this.rooms[0];
    this.traps = new Map(); // key(x,y) -> {type, power}
    for (let i = 1; i < this.rooms.length - 1; i++) {
      if (RNG.chance(0.25)) {
        const r = this.rooms[i];
        const cx = clamp(r.cx + RNG.int(-1, 1), r.x, r.x + r.w - 1);
        const cy = clamp(r.cy + RNG.int(-1, 1), r.y, r.y + r.h - 1);
        if (this.get(cx, cy) === TILE.FLOOR) this.set(cx, cy, TILE.CHEST);
      }
    }
    // Scatter hidden traps. More common, and a bit harder-hitting, on deeper floors.
    const trapCount = Math.min(14, 2 + Math.floor(this.depth * 0.8));
    let placed = 0, attempts = 0;
    while (placed < trapCount && attempts < trapCount * 20) {
      attempts++;
      const room = RNG.pick(this.rooms.slice(1));
      if (!room) break;
      const x = RNG.int(room.x, room.x + room.w - 1);
      const y = RNG.int(room.y, room.y + room.h - 1);
      if (this.get(x, y) !== TILE.FLOOR) continue;
      if (x === this.startRoom.cx && y === this.startRoom.cy) continue;
      const trapType = RNG.pick(["spike", "poison", "fire"]);
      const power = trapType === "spike" ? RNG.int(4, 7) + Math.floor(this.depth / 2)
                  : RNG.int(2, 4) + Math.floor(this.depth / 3);
      this.set(x, y, TILE.TRAP_HIDDEN);
      this.traps.set(key(x, y), { type: trapType, power });
      placed++;
    }
  }
}

// ---------- Recursive Shadowcasting FOV ----------
// Computes visible tiles from (ox,oy) up to given radius.
const MULT = [
  [4, 4, 4, 4, 4, 4, 4, 4],
  [5, 1, 1, 5, 5, 1, 1, 5],
  [6, 2, 1, 1, 1, 1, 2, 6],
  [7, 3, 2, 1, 1, 2, 3, 7]
];
function computeFOV(dungeon, ox, oy, radius, visibleSet) {
  visibleSet.add(key(ox, oy));
  for (let octant = 0; octant < 8; octant++) {
    castLight(dungeon, ox, oy, 1, 1.0, 0.0, radius,
      MULT[0][octant] !== undefined ? rowMult(octant) : null, octant, visibleSet);
  }
}
function rowMult(octant) {
  const table = [
    [1, 0, 0, 1], [0, 1, 1, 0], [0, -1, 1, 0], [-1, 0, 0, 1],
    [-1, 0, 0, -1], [0, -1, -1, 0], [0, 1, -1, 0], [1, 0, 0, -1]
  ];
  return table[octant];
}
function castLight(dungeon, ox, oy, row, start, end, radius, xx_xy_yx_yy, octant, visibleSet) {
  if (start < end) return;
  const [xx, xy, yx, yy] = xx_xy_yx_yy;
  let newStart = start;
  for (let i = row; i <= radius; i++) {
    let blocked = false;
    for (let dx = -i, dy = -i; dx <= 0; dx++) {
      const l_slope = (dx - 0.5) / (dy + 0.5);
      const r_slope = (dx + 0.5) / (dy - 0.5);
      if (start < r_slope) continue;
      if (end > l_slope) break;
      const sax = dx * xx + dy * xy;
      const say = dx * yx + dy * yy;
      const ax = ox + sax, ay = oy + say;
      if (Math.hypot(sax, say) > radius) continue;
      const t = dungeon.get(ax, ay);
      const isWall = t === TILE.WALL;
      if (!isWall || !blocked) visibleSet.add(key(ax, ay));
      if (blocked) {
        if (isWall) { newStart = r_slope; continue; }
        else { blocked = false; start = newStart; }
      } else {
        if (isWall && i < radius) {
          blocked = true;
          castLight(dungeon, ox, oy, i + 1, start, l_slope, radius, [xx, xy, yx, yy], octant, visibleSet);
          newStart = r_slope;
        }
      }
    }
    if (blocked) break;
  }
}

// ---------- A* Pathfinding ----------
function astar(dungeon, start, goal, blockedSet) {
  const open = new Map();
  const closed = new Set();
  const startKey = key(start.x, start.y);
  open.set(startKey, { x: start.x, y: start.y, g: 0, f: dist(start, goal), parent: null });
  let iterations = 0;
  while (open.size && iterations < 3000) {
    iterations++;
    let currentKey = null, current = null;
    for (const [k, node] of open) {
      if (!current || node.f < current.f) { current = node; currentKey = k; }
    }
    if (current.x === goal.x && current.y === goal.y) {
      const path = [];
      let n = current;
      while (n) { path.unshift({ x: n.x, y: n.y }); n = n.parent; }
      return path;
    }
    open.delete(currentKey);
    closed.add(currentKey);
    const neighbors = [
      { x: current.x + 1, y: current.y }, { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 }, { x: current.x, y: current.y - 1 }
    ];
    for (const n of neighbors) {
      const nk = key(n.x, n.y);
      if (closed.has(nk)) continue;
      if (!dungeon.isWalkable(n.x, n.y)) continue;
      if (blockedSet && blockedSet.has(nk) && !(n.x === goal.x && n.y === goal.y)) continue;
      const g = current.g + 1;
      const existing = open.get(nk);
      const h = dist(n, goal);
      if (!existing || g < existing.g) {
        open.set(nk, { x: n.x, y: n.y, g, f: g + h, parent: current });
      }
    }
  }
  return null;
}

// ---------- Status Effects ----------
// Each status: { type, turns, power }. Applied to any entity with a .statuses array.
const STATUS = { POISON: "poison", BURNING: "burning", STUNNED: "stunned", REGEN: "regen" };

function applyStatus(entity, type, turns, power) {
  if (!entity.statuses) entity.statuses = [];
  const existing = entity.statuses.find(s => s.type === type);
  if (existing) {
    existing.turns = Math.max(existing.turns, turns);
    existing.power = Math.max(existing.power, power);
  } else {
    entity.statuses.push({ type, turns, power });
  }
}

function hasStatus(entity, type) {
  return !!(entity.statuses && entity.statuses.find(s => s.type === type));
}

// Ticks all statuses on an entity by one turn. Returns true if the entity died from a status.
function tickStatuses(entity, name, isPlayer) {
  if (!entity.statuses || entity.statuses.length === 0) return false;
  const remaining = [];
  for (const s of entity.statuses) {
    if (s.type === STATUS.POISON) {
      entity.hp -= s.power;
      addLog(`${name} suffers ${s.power} poison damage.`);
      if (isPlayer) flashScreen("#0a0", 6);
    } else if (s.type === STATUS.BURNING) {
      entity.hp -= s.power;
      addLog(`${name} burns for ${s.power} damage.`);
      if (isPlayer) flashScreen("#f60", 6);
    } else if (s.type === STATUS.REGEN) {
      const heal = Math.min(s.power, (entity.maxHp || entity.hp) - entity.hp);
      if (heal > 0) entity.hp += heal;
    }
    s.turns--;
    if (s.turns > 0) remaining.push(s);
  }
  entity.statuses = remaining;
  if (entity.hp <= 0) return true;
  return false;
}


const ITEM_TEMPLATES = {
  weapon: [
    { name: "Dagger", baseDmg: [2, 4], rarity: 1 },
    { name: "Short Sword", baseDmg: [3, 6], rarity: 1 },
    { name: "Long Sword", baseDmg: [5, 9], rarity: 2 },
    { name: "War Axe", baseDmg: [6, 12], rarity: 3 },
    { name: "Runic Blade", baseDmg: [9, 16], rarity: 4 },
    { name: "Short Bow", baseDmg: [2, 5], rarity: 2, ranged: true, range: 6 },
    { name: "Longbow", baseDmg: [4, 8], rarity: 3, ranged: true, range: 8 },
    { name: "Venom Bow", baseDmg: [2, 4], rarity: 3, ranged: true, range: 7, applyPoison: true },
    { name: "Wand of Fire", baseDmg: [5, 9], rarity: 4, ranged: true, range: 5, applyBurn: true }
  ],
  armor: [
    { name: "Cloth Robe", def: 1, rarity: 1 },
    { name: "Leather Armor", def: 3, rarity: 1 },
    { name: "Chainmail", def: 5, rarity: 2 },
    { name: "Plate Armor", def: 8, rarity: 3 },
    { name: "Dragonscale", def: 12, rarity: 4 }
  ],
  potion: [
    { name: "Minor Healing Potion", heal: 12, rarity: 1 },
    { name: "Healing Potion", heal: 25, rarity: 2 },
    { name: "Greater Healing Potion", heal: 50, rarity: 3 }
  ],
  scroll: [
    { name: "Scroll of Fireball", effect: "fireball", power: 18, rarity: 2 },
    { name: "Scroll of Teleport", effect: "teleport", rarity: 2 }
  ]
};

function rollRarity(depth) {
  const r = RNG.float();
  const bias = Math.min(depth * 0.05, 0.5);
  if (r < 0.55 - bias) return 1;
  if (r < 0.8 - bias * 0.5) return 2;
  if (r < 0.94) return 3;
  return 4;
}

function generateItem(depth) {
  const types = ["weapon", "armor", "potion", "scroll"];
  const type = RNG.pick(types);
  const rarity = rollRarity(depth);
  const pool = ITEM_TEMPLATES[type].filter(t => t.rarity <= rarity);
  const template = pool.length ? RNG.pick(pool) : ITEM_TEMPLATES[type][0];
  const item = Object.assign({ type, id: Math.random().toString(36).slice(2) }, template);
  if (type === "weapon") {
    const bonus = Math.floor(depth / 2);
    item.dmgMin = item.baseDmg[0] + bonus;
    item.dmgMax = item.baseDmg[1] + bonus;
  }
  if (type === "armor") {
    item.def = item.def + Math.floor(depth / 3);
  }
  return item;
}

// ---------- Monster templates ----------
const MONSTER_TEMPLATES = [
  { name: "Rat", glyph: "r", hp: 6, atk: [1, 2], def: 0, xp: 4, minDepth: 1 },
  { name: "Goblin", glyph: "g", hp: 12, atk: [2, 4], def: 1, xp: 8, minDepth: 1 },
  { name: "Goblin Archer", glyph: "a", hp: 10, atk: [2, 5], def: 0, xp: 10, minDepth: 2, ranged: true, range: 5 },
  { name: "Skeleton", glyph: "s", hp: 18, atk: [3, 6], def: 2, xp: 14, minDepth: 2 },
  { name: "Orc", glyph: "o", hp: 26, atk: [4, 8], def: 3, xp: 22, minDepth: 3 },
  { name: "Wraith", glyph: "w", hp: 30, atk: [5, 9], def: 2, xp: 30, minDepth: 4 },
  { name: "Necromancer", glyph: "n", hp: 22, atk: [3, 7], def: 1, xp: 35, minDepth: 4, ranged: true, range: 6, poisonBolt: true },
  { name: "Troll", glyph: "T", hp: 45, atk: [6, 12], def: 4, xp: 45, minDepth: 5 },
  { name: "Dragon Whelp", glyph: "D", hp: 60, atk: [8, 16], def: 6, xp: 80, minDepth: 7 }
];

const BOSS_TEMPLATES = [
  { name: "The Dungeon Lord", glyph: "&", hp: 160, atk: [10, 18], def: 8, xp: 500, gold: 150,
    ranged: true, range: 6, poisonBolt: true, enrageBelow: 0.4, depth: 10 },
  { name: "The Ashen Queen", glyph: "Q", hp: 320, atk: [14, 26], def: 11, xp: 1100, gold: 350,
    ranged: true, range: 7, poisonBolt: false, applyBurn: true, enrageBelow: 0.4, depth: 20 },
  { name: "The Void Devourer", glyph: "V", hp: 520, atk: [20, 36], def: 14, xp: 2200, gold: 700,
    ranged: true, range: 8, poisonBolt: true, applyBurn: true, enrageBelow: 0.35, depth: 30 }
];

function bossTemplateForDepth(depth) {
  return BOSS_TEMPLATES.find(b => b.depth === depth) || null;
}

function isFinalBossDepth(depth) {
  return depth === BOSS_TEMPLATES[BOSS_TEMPLATES.length - 1].depth;
}

function spawnMonster(depth, x, y) {
  const pool = MONSTER_TEMPLATES.filter(m => m.minDepth <= depth);
  const t = RNG.pick(pool);
  const scale = 1 + (depth - t.minDepth) * 0.12;
  return {
    name: t.name, glyph: t.glyph, x, y,
    hp: Math.round(t.hp * scale), maxHp: Math.round(t.hp * scale),
    atkMin: t.atk[0], atkMax: Math.round(t.atk[1] * scale),
    def: t.def, xp: Math.round(t.xp * scale),
    gold: RNG.int(1, 4) + Math.floor(depth * 1.5),
    ranged: !!t.ranged, range: t.range || 0, poisonBolt: !!t.poisonBolt,
    alive: true, lastSeenPlayer: null, statuses: []
  };
}

function spawnBoss(x, y, depth) {
  const t = bossTemplateForDepth(depth);
  return {
    name: t.name, glyph: t.glyph, x, y,
    hp: t.hp, maxHp: t.hp,
    atkMin: t.atk[0], atkMax: t.atk[1],
    def: t.def, xp: t.xp, gold: t.gold,
    ranged: true, range: t.range, poisonBolt: !!t.poisonBolt, applyBurn: !!t.applyBurn,
    enrageBelow: t.enrageBelow, enraged: false,
    isBoss: true, bossTier: BOSS_TEMPLATES.indexOf(t), alive: true, lastSeenPlayer: null, statuses: []
  };
}


const game = {
  depth: 1,
  dungeon: null,
  player: null,
  monsters: [],
  items: [],         // items on the ground: {x,y,item}
  visible: new Set(),
  explored: new Set(),
  log: [],
  turn: 0,
  gameOver: false,
  won: false,
  invVisible: false,
  flashColor: null,
  flashTimer: 0,
  shakeTimer: 0,
  shakeMag: 0
};

function newPlayer() {
  return {
    x: 0, y: 0, hp: 30, maxHp: 30, mp: 10, maxMp: 10,
    level: 1, xp: 0, xpNext: 20,
    str: 5, def: 2,
    weapon: { name: "Fists", dmgMin: 1, dmgMax: 3, type: "weapon" },
    armor: null,
    inventory: [],
    gold: 0,
    statuses: []
  };
}

function addLog(msg) {
  game.log.push(msg);
  if (game.log.length > 7) game.log.shift();
  document.getElementById("log").textContent = game.log.join("\n");
}

function flashScreen(color, frames) {
  game.flashColor = color;
  game.flashTimer = frames;
}

function shakeScreen(magnitude, frames) {
  game.shakeMag = magnitude;
  game.shakeTimer = frames;
}

function newGame() {
  game.depth = 1;
  game.player = newPlayer();
  game.log = [];
  game.gameOver = false;
  game.won = false;
  game.isBossLevel = false;
  game.isShopLevel = false;
  game.pendingShopFloor = false;
  game.shopkeeper = null;
  game.shopStock = null;
  addLog("You descend into the dungeon. Find the stairs (>) to go deeper.");
  enterLevel(1);
}

// Finds a walkable tile in the given room that is NOT the stairs tile, biased
// toward being a few tiles away from room center so the boss doesn't spawn
// standing directly on (or blocking) the stairs.
function findBossSpawnSpot(dungeon, room) {
  const stairs = dungeon.stairsPos;
  const candidates = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (!dungeon.isWalkable(x, y)) continue;
      if (stairs && x === stairs.x && y === stairs.y) continue;
      candidates.push({ x, y, d: Math.abs(x - room.cx) + Math.abs(y - room.cy) });
    }
  }
  if (candidates.length === 0) return { x: room.cx, y: room.cy };
  // Prefer tiles a little away from the exact center (where stairs usually
  // sit) but still within the room — sort by distance from center descending
  // is too far (could hug walls), so just pick from the farther half.
  candidates.sort((a, b) => b.d - a.d);
  const pool = candidates.slice(0, Math.max(1, Math.floor(candidates.length / 2)));
  return RNG.pick(pool);
}

function enterLevel(depth) {
  game.depth = depth;
  game.isShopLevel = false;

  if (game.pendingShopFloor) {
    game.pendingShopFloor = false;
    enterShopLevel(depth);
    return;
  }

  const w = 60, h = 38;
  game.dungeon = new Dungeon(w, h, depth);
  game.player.x = game.dungeon.startRoom.cx;
  game.player.y = game.dungeon.startRoom.cy;
  game.monsters = [];
  game.items = [];
  game.visible = new Set();
  game.explored = new Set();
  game.isBossLevel = !!bossTemplateForDepth(depth);
  game.shopkeeper = null;
  game.shopStock = null;

  if (game.isBossLevel) {
    const bossRoom = game.dungeon.rooms[game.dungeon.rooms.length - 1];
    const spot = findBossSpawnSpot(game.dungeon, bossRoom);
    game.monsters.push(spawnBoss(spot.x, spot.y, depth));
    addLog("You sense a powerful presence on this floor...");
  }

  const numMonsters = Math.min(28, game.isBossLevel ? Math.floor((4 + depth * 2) * 0.5) : (4 + depth * 2));
  for (let i = 0; i < numMonsters; i++) {
    const room = RNG.pick(game.dungeon.rooms.slice(1));
    if (!room) continue;
    const x = RNG.int(room.x, room.x + room.w - 1);
    const y = RNG.int(room.y, room.y + room.h - 1);
    if (game.dungeon.isWalkable(x, y) && !(x === game.player.x && y === game.player.y)) {
      game.monsters.push(spawnMonster(depth, x, y));
    }
  }

  for (let i = 1; i < game.dungeon.rooms.length; i++) {
    if (RNG.chance(0.4)) {
      const room = game.dungeon.rooms[i];
      const x = RNG.int(room.x, room.x + room.w - 1);
      const y = RNG.int(room.y, room.y + room.h - 1);
      if (game.dungeon.isWalkable(x, y)) {
        game.items.push({ x, y, item: generateItem(depth) });
      }
    }
  }
  recomputeFOV();
}

function recomputeFOV() {
  game.visible = new Set();
  computeFOV(game.dungeon, game.player.x, game.player.y, 8, game.visible);
  for (const k of game.visible) game.explored.add(k);
}

// A shop floor is a small, hand-carved, monster-free room that appears right
// after a boss kill. We reuse the Dungeon class for its tile grid/FOV
// compatibility but skip BSP generation entirely and carve a single room.
function enterShopLevel(depth) {
  game.isShopLevel = true;
  game.isBossLevel = false;
  const w = 24, h = 14;
  const d = new Dungeon(w, h, depth);
  d.tiles = new Array(w * h).fill(TILE.WALL);
  d.rooms = [];
  d.traps = new Map();
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) d.set(x, y, TILE.FLOOR);
  }
  const room = { x: 2, y: 2, w: w - 4, h: h - 4, cx: Math.floor(w / 2), cy: Math.floor(h / 2) };
  d.rooms.push(room);
  d.startRoom = room;
  const stairsX = w - 4, stairsY = h - 4;
  d.set(stairsX, stairsY, TILE.STAIRS_DOWN);
  d.stairsPos = { x: stairsX, y: stairsY };

  game.dungeon = d;
  game.player.x = 3;
  game.player.y = room.cy;
  game.monsters = [];
  game.items = [];
  game.visible = new Set();
  game.explored = new Set();

  game.shopkeeper = { x: room.cx, y: room.cy, glyph: "$" };
  game.shopStock = generateShopStock(game.depth);
  addLog("You step into a quiet trading post. Stock up before diving deeper.");
  recomputeFOV();
}

function generateShopStock(depth) {
  // A handful of items spanning all categories, priced by rarity AND depth, plus
  // always at least one healing potion so a bad-luck run can still recover.
  const stock = [];
  for (let i = 0; i < 5; i++) {
    const itemDepth = depth + RNG.int(0, 3);
    const item = generateItem(itemDepth);
    stock.push({ item, price: priceItem(item, depth) });
  }
  const potion = ITEM_TEMPLATES.potion[Math.min(1, ITEM_TEMPLATES.potion.length - 1)];
  const guaranteedPotion = Object.assign({ type: "potion", id: Math.random().toString(36).slice(2) }, potion);
  stock.push({ item: guaranteedPotion, price: priceItem(guaranteedPotion, depth) });
  return stock;
}

function priceItem(item, depth) {
  const base = { weapon: 25, armor: 20, potion: 8, scroll: 15 }[item.type] || 10;
  const rarityMult = item.rarity || 1;
  // Depth scaling mirrors how item stats themselves grow with depth (see
  // generateItem's dmgMin/dmgMax/def bonuses), so price keeps pace with power
  // instead of staying flat while monster gold income keeps climbing.
  const depthMult = 1 + (depth || 1) * 0.12;
  return Math.round(base * rarityMult * depthMult * (1 + RNG.float() * 0.3));
}

function buyItem(n) {
  const entry = game.shopStock[n];
  if (!entry) { addLog("No such item in the shop."); return; }
  if (game.player.gold < entry.price) {
    addLog(`You can't afford the ${entry.item.name} (${entry.price}g, you have ${game.player.gold}g).`);
    return;
  }
  game.player.gold -= entry.price;
  game.player.inventory.push(entry.item);
  game.shopStock.splice(n, 1);
  addLog(`You buy the ${entry.item.name} for ${entry.price}g.`);
  renderInventory();
}

// ---------- Combat ----------
function rollDamage(min, max) { return RNG.int(min, max); }

function playerAttack(monster) {
  const weapon = game.player.weapon;
  const dmg = Math.max(1, rollDamage(weapon.dmgMin, weapon.dmgMax) + Math.floor(game.player.str / 3) - monster.def);
  monster.hp -= dmg;
  addLog(`You hit the ${monster.name} for ${dmg} damage.`);
  shakeScreen(2, 4);
  if (weapon.applyPoison) {
    applyStatus(monster, STATUS.POISON, 4, 3);
    addLog(`The ${monster.name} is poisoned!`);
  }
  if (weapon.applyBurn) {
    applyStatus(monster, STATUS.BURNING, 3, 4);
    addLog(`The ${monster.name} catches fire!`);
  }
  checkMonsterDeath(monster);
}

function checkMonsterDeath(monster) {
  if (monster.hp <= 0 && monster.alive) {
    monster.alive = false;
    addLog(`The ${monster.name} dies! +${monster.xp} XP`);
    if (monster.gold) {
      game.player.gold += monster.gold;
      addLog(`You loot ${monster.gold} gold.`);
    }
    if (monster.isBoss) {
      if (isFinalBossDepth(game.depth)) {
        game.won = true;
        game.gameOver = true;
        addLog(`You have slain ${monster.name}! YOU WIN!`);
      } else {
        game.pendingShopFloor = true;
        addLog(`You have slain ${monster.name}! The stairs unlock, and you sense a safe haven below.`);
      }
    }
    gainXP(monster.xp);
  }
}

function monsterAttack(monster) {
  const playerDef = game.player.def + (game.player.armor ? game.player.armor.def : 0);
  let atkMin = monster.atkMin, atkMax = monster.atkMax;
  if (monster.isBoss && monster.hp / monster.maxHp < monster.enrageBelow) {
    if (!monster.enraged) { monster.enraged = true; addLog(`${monster.name} flies into a rage!`); }
    atkMin = Math.round(atkMin * 1.5);
    atkMax = Math.round(atkMax * 1.5);
  }
  const dmg = Math.max(1, rollDamage(atkMin, atkMax) - playerDef);
  game.player.hp -= dmg;
  addLog(`The ${monster.name} hits you for ${dmg} damage.`);
  flashScreen("#f00", 8);
  shakeScreen(monster.isBoss ? 6 : 3, 6);
  checkPlayerDeath();
}

function rangedAttack(monster) {
  const playerDef = game.player.def + (game.player.armor ? game.player.armor.def : 0);
  const dmg = Math.max(1, rollDamage(monster.atkMin, monster.atkMax) - playerDef - 1);
  game.player.hp -= dmg;
  addLog(`The ${monster.name} shoots you for ${dmg} damage.`);
  flashScreen("#f00", 6);
  shakeScreen(2, 5);
  if (monster.poisonBolt) {
    applyStatus(game.player, STATUS.POISON, 3, 2);
    addLog("The bolt was poisoned!");
  }
  if (monster.applyBurn) {
    applyStatus(game.player, STATUS.BURNING, 3, 3);
    addLog("The shot sets you ablaze!");
  }
  checkPlayerDeath();
}

function checkPlayerDeath() {
  if (game.player.hp <= 0) {
    game.player.hp = 0;
    game.gameOver = true;
    addLog(`You died on depth ${game.depth}. Press F1 to restart.`);
  }
}

// Returns true if there's a clear straight line (horizontal, vertical, or
// diagonal) between two points with no walls in between — used for ranged
// attacks by both the player and ranged monsters.
function hasLineOfSight(dungeon, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return true;
  const stepX = dx / steps, stepY = dy / steps;
  for (let i = 1; i < steps; i++) {
    const cx = Math.round(x0 + stepX * i);
    const cy = Math.round(y0 + stepY * i);
    if (dungeon.get(cx, cy) === TILE.WALL) return false;
  }
  return true;
}

function isStraightLine(x0, y0, x1, y1) {
  return x0 === x1 || y0 === y1 || Math.abs(x1 - x0) === Math.abs(y1 - y0);
}

function playerShoot() {
  const weapon = game.player.weapon;
  if (!weapon.ranged) { addLog("You don't have a ranged weapon equipped."); return; }
  const targets = game.monsters.filter(m => m.alive &&
    game.visible.has(key(m.x, m.y)) &&
    isStraightLine(game.player.x, game.player.y, m.x, m.y) &&
    dist(m, game.player) <= weapon.range &&
    hasLineOfSight(game.dungeon, game.player.x, game.player.y, m.x, m.y));
  if (targets.length === 0) { addLog("No target in a clear line of fire."); return; }
  targets.sort((a, b) => dist(a, game.player) - dist(b, game.player));
  const target = targets[0];
  const dmg = Math.max(1, rollDamage(weapon.dmgMin, weapon.dmgMax) - target.def);
  target.hp -= dmg;
  addLog(`You shoot the ${target.name} for ${dmg} damage.`);
  if (weapon.applyPoison) applyStatus(target, STATUS.POISON, 4, 3);
  if (weapon.applyBurn) applyStatus(target, STATUS.BURNING, 3, 4);
  checkMonsterDeath(target);
  endTurn();
}

function gainXP(amount) {
  game.player.xp += amount;
  while (game.player.xp >= game.player.xpNext) {
    game.player.xp -= game.player.xpNext;
    game.player.level++;
    game.player.xpNext = Math.round(game.player.xpNext * 1.5);
    game.player.maxHp += 8;
    game.player.hp = game.player.maxHp;
    game.player.str += 1;
    game.player.def += 1;
    addLog(`Level up! You are now level ${game.player.level}.`);
  }
}

// ---------- Player actions ----------
function tryMovePlayer(dx, dy) {
  if (game.gameOver) return;
  const nx = game.player.x + dx, ny = game.player.y + dy;
  const monster = game.monsters.find(m => m.alive && m.x === nx && m.y === ny);
  if (monster) {
    playerAttack(monster);
    endTurn();
    return;
  }
  if (game.shopkeeper && nx === game.shopkeeper.x && ny === game.shopkeeper.y) {
    addLog("The shopkeeper nods at you. Press B to browse their stock.");
    return;
  }
  if (game.dungeon.isWalkable(nx, ny)) {
    game.player.x = nx; game.player.y = ny;
    const t = game.dungeon.get(nx, ny);
    if (t === TILE.CHEST) {
      game.dungeon.set(nx, ny, TILE.FLOOR);
      const goldFound = RNG.int(5, 15) + game.depth * 2;
      game.player.gold += goldFound;
      if (RNG.chance(0.7)) {
        const item = generateItem(game.depth);
        game.player.inventory.push(item);
        addLog(`You open a chest and find: ${item.name} and ${goldFound} gold!`);
      } else {
        addLog(`You open a chest and find ${goldFound} gold.`);
      }
    } else if (t === TILE.TRAP_HIDDEN) {
      triggerTrap(nx, ny);
    }
    endTurn();
  }
}

function triggerTrap(x, y) {
  const trap = game.dungeon.traps.get(key(x, y));
  game.dungeon.set(x, y, TILE.TRAP_REVEALED);
  if (!trap) return;
  if (trap.type === "spike") {
    game.player.hp -= trap.power;
    addLog(`A spike trap triggers! You take ${trap.power} damage.`);
    flashScreen("#f00", 8);
    shakeScreen(4, 8);
  } else if (trap.type === "poison") {
    applyStatus(game.player, STATUS.POISON, 4, trap.power);
    addLog(`A poison trap triggers! You feel sickly.`);
    flashScreen("#0a0", 8);
  } else if (trap.type === "fire") {
    applyStatus(game.player, STATUS.BURNING, 3, trap.power);
    addLog(`A fire trap triggers! You are set ablaze.`);
    flashScreen("#f60", 8);
  }
  if (game.player.hp <= 0) {
    game.player.hp = 0;
    game.gameOver = true;
    addLog(`You died on depth ${game.depth}. Press F1 to restart.`);
  }
}

function pickupItem() {
  const idx = game.items.findIndex(it => it.x === game.player.x && it.y === game.player.y);
  if (idx >= 0) {
    const it = game.items.splice(idx, 1)[0];
    game.player.inventory.push(it.item);
    addLog(`You pick up: ${it.item.name}.`);
    renderInventory();
  } else {
    addLog("There is nothing here to pick up.");
  }
}

function useItem(n) {
  const item = game.player.inventory[n];
  if (!item) { addLog("No such item."); return; }
  if (item.type === "weapon") {
    game.player.weapon = item;
    game.player.inventory.splice(n, 1);
    addLog(`You equip the ${item.name}.`);
  } else if (item.type === "armor") {
    game.player.armor = item;
    game.player.inventory.splice(n, 1);
    addLog(`You equip the ${item.name}.`);
  } else if (item.type === "potion") {
    game.player.hp = Math.min(game.player.maxHp, game.player.hp + item.heal);
    game.player.inventory.splice(n, 1);
    addLog(`You drink the ${item.name}, healing ${item.heal} HP.`);
  } else if (item.type === "scroll") {
    if (item.effect === "fireball") {
      let hit = 0;
      for (const m of game.monsters) {
        if (m.alive && dist(m, game.player) <= 3) {
          m.hp -= item.power; hit++;
          if (m.hp <= 0) { m.alive = false; gainXP(m.xp); }
        }
      }
      addLog(`The scroll erupts in flame, hitting ${hit} enemies!`);
    } else if (item.effect === "teleport") {
      const room = RNG.pick(game.dungeon.rooms);
      game.player.x = room.cx; game.player.y = room.cy;
      addLog("You teleport to a random location.");
    }
    game.player.inventory.splice(n, 1);
  }
  renderInventory();
  endTurn();
}

function dropItem(n) {
  const item = game.player.inventory[n];
  if (!item) { addLog("No such item."); return; }
  game.player.inventory.splice(n, 1);
  game.items.push({ x: game.player.x, y: game.player.y, item });
  addLog(`You drop the ${item.name}.`);
  renderInventory();
}

function restPlayer() {
  if (game.gameOver) return;
  const nearbyMonster = game.monsters.some(m => m.alive && dist(m, game.player) < 6);
  if (nearbyMonster) {
    addLog("You can't rest with enemies nearby!");
    return;
  }
  game.player.hp = Math.min(game.player.maxHp, game.player.hp + 5);
  addLog("You rest and recover a little HP.");
  endTurn();
}

function tryDescend() {
  if (game.isBossLevel) {
    const boss = game.monsters.find(m => m.isBoss);
    if (boss && boss.alive) {
      addLog("The stairs are sealed by dark magic. Defeat the Dungeon Lord first!");
      return;
    }
  }
  if (game.dungeon.get(game.player.x, game.player.y) === TILE.STAIRS_DOWN) {
    addLog(`You descend to depth ${game.depth + 1}.`);
    enterLevel(game.depth + 1);
  } else {
    addLog("There are no stairs here.");
  }
}

// ---------- Monster AI turn ----------
function monsterTurn() {
  const occupied = new Set(game.monsters.filter(m => m.alive).map(m => key(m.x, m.y)));
  for (const m of game.monsters) {
    if (!m.alive) continue;
    if (hasStatus(m, STATUS.STUNNED)) continue;
    const d = dist(m, game.player);
    const mk = key(m.x, m.y);
    const seesPlayer = game.visible.has(mk) && d < 9;
    if (seesPlayer) m.lastSeenPlayer = { x: game.player.x, y: game.player.y };

    if (d <= 1.4 && seesPlayer) {
      monsterAttack(m);
      continue;
    }
    if (m.ranged && seesPlayer && d <= m.range &&
        isStraightLine(m.x, m.y, game.player.x, game.player.y) &&
        hasLineOfSight(game.dungeon, m.x, m.y, game.player.x, game.player.y)) {
      rangedAttack(m);
      continue;
    }
    const target = seesPlayer ? game.player : m.lastSeenPlayer;
    if (!target) continue;

    occupied.delete(mk);
    const path = astar(game.dungeon, m, target, occupied);
    if (path && path.length > 1) {
      const next = path[1];
      if (!(next.x === game.player.x && next.y === game.player.y) &&
          !occupied.has(key(next.x, next.y))) {
        m.x = next.x; m.y = next.y;
      }
    }
    occupied.add(key(m.x, m.y));

    if (!seesPlayer && m.lastSeenPlayer && m.x === m.lastSeenPlayer.x && m.y === m.lastSeenPlayer.y) {
      m.lastSeenPlayer = null;
    }
  }
}

function tickAllStatuses() {
  const playerDied = tickStatuses(game.player, "You", true);
  if (playerDied) checkPlayerDeath();
  for (const m of game.monsters) {
    if (!m.alive) continue;
    const died = tickStatuses(m, "The " + m.name, false);
    if (died) checkMonsterDeath(m);
  }
}

function endTurn() {
  game.turn++;
  if (!game.gameOver) tickAllStatuses();
  if (!game.gameOver) monsterTurn();
  recomputeFOV();
  render();
}

// ---------- Rendering ----------
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const TS = 16; // tile size in px
const VIEW_W = Math.floor(canvas.width / TS);
const VIEW_H = Math.floor(canvas.height / TS);

function glyphFor(t) {
  switch (t) {
    case TILE.WALL: return "#";
    case TILE.FLOOR: return ".";
    case TILE.DOOR: return "+";
    case TILE.STAIRS_DOWN: return ">";
    case TILE.CHEST: return "$";
    case TILE.TRAP_HIDDEN: return ".";
    case TILE.TRAP_REVEALED: return "^";
    default: return " ";
  }
}

function render() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = (TS - 2) + "px monospace";
  ctx.textBaseline = "top";

  // Screen shake: small random offset for a few frames after a big hit.
  let shakeX = 0, shakeY = 0;
  if (game.shakeTimer > 0) {
    shakeX = RNG.int(-game.shakeMag, game.shakeMag);
    shakeY = RNG.int(-game.shakeMag, game.shakeMag);
    game.shakeTimer--;
  }
  ctx.save();
  ctx.translate(shakeX, shakeY);

  const camX = clamp(game.player.x - Math.floor(VIEW_W / 2), 0, Math.max(0, game.dungeon.w - VIEW_W));
  const camY = clamp(game.player.y - Math.floor(VIEW_H / 2), 0, Math.max(0, game.dungeon.h - VIEW_H));

  for (let sy = 0; sy < VIEW_H; sy++) {
    for (let sx = 0; sx < VIEW_W; sx++) {
      const wx = camX + sx, wy = camY + sy;
      const k = key(wx, wy);
      const isVisible = game.visible.has(k);
      const isExplored = game.explored.has(k);
      if (!isVisible && !isExplored) continue;
      const t = game.dungeon.get(wx, wy);
      if (t === TILE.TRAP_REVEALED) {
        ctx.fillStyle = isVisible ? "#fa0" : "#640";
      } else {
        ctx.fillStyle = isVisible ? "#0f0" : "#063";
      }
      ctx.fillText(glyphFor(t), sx * TS, sy * TS);
    }
  }

  for (const it of game.items) {
    const k = key(it.x, it.y);
    if (!game.visible.has(k)) continue;
    const sx = it.x - camX, sy = it.y - camY;
    if (sx < 0 || sy < 0 || sx >= VIEW_W || sy >= VIEW_H) continue;
    ctx.fillStyle = "#ff0";
    ctx.fillText("!", sx * TS, sy * TS);
  }

  for (const m of game.monsters) {
    if (!m.alive) continue;
    const k = key(m.x, m.y);
    if (!game.visible.has(k)) continue;
    const sx = m.x - camX, sy = m.y - camY;
    if (sx < 0 || sy < 0 || sx >= VIEW_W || sy >= VIEW_H) continue;
    ctx.fillStyle = m.isBoss ? (m.enraged ? "#f0f" : "#f90") : "#f33";
    ctx.fillText(m.glyph, sx * TS, sy * TS);
  }

  if (game.shopkeeper) {
    const sx = game.shopkeeper.x - camX, sy = game.shopkeeper.y - camY;
    if (sx >= 0 && sy >= 0 && sx < VIEW_W && sy < VIEW_H) {
      ctx.fillStyle = "#0ff";
      ctx.fillText(game.shopkeeper.glyph, sx * TS, sy * TS);
    }
  }

  const psx = game.player.x - camX, psy = game.player.y - camY;
  ctx.fillStyle = hasStatus(game.player, STATUS.POISON) ? "#0f8"
                 : hasStatus(game.player, STATUS.BURNING) ? "#f80"
                 : "#fff";
  ctx.fillText("@", psx * TS, psy * TS);

  ctx.restore();

  // Damage/status flash: a translucent color wash over the whole canvas for a few frames.
  if (game.flashTimer > 0) {
    ctx.fillStyle = game.flashColor;
    ctx.globalAlpha = 0.18 * (game.flashTimer / 8);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    game.flashTimer--;
  }

  renderMinimap();
  renderStats();
}

function renderMinimap() {
  // Small top-down overview in the corner: explored tiles only, no monster/item detail.
  // Each dungeon tile maps to a 2px dot with a 1px gap, so rooms/corridors stay
  // visually distinct instead of merging into solid color blocks.
  const cell = 2, gap = 1;
  const mmW = game.dungeon.w * cell;
  const mmH = game.dungeon.h * cell;
  const ox = canvas.width - mmW - 12;
  const oy = 8;
  // Fully opaque backing so the minimap reads as its own panel rather than
  // letting the dungeon view underneath bleed through.
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(ox - 4, oy - 4, mmW + 8, mmH + 8);
  ctx.strokeStyle = "#063";
  ctx.lineWidth = 1;
  ctx.strokeRect(ox - 4, oy - 4, mmW + 8, mmH + 8);
  for (let y = 0; y < game.dungeon.h; y++) {
    for (let x = 0; x < game.dungeon.w; x++) {
      const k = key(x, y);
      if (!game.explored.has(k)) continue;
      const t = game.dungeon.get(x, y);
      if (t === TILE.WALL) continue;
      ctx.fillStyle = t === TILE.STAIRS_DOWN ? "#0ff" : game.visible.has(k) ? "#0f0" : "#063";
      ctx.fillRect(ox + x * cell, oy + y * cell, cell - gap, cell - gap);
    }
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(ox + game.player.x * cell - 1, oy + game.player.y * cell - 1, cell + 1, cell + 1);
  ctx.globalAlpha = 1;
}

function renderStats() {
  const p = game.player;
  const armorDef = p.armor ? p.armor.def : 0;
  const statusText = (p.statuses && p.statuses.length)
    ? "Status: " + p.statuses.map(s => `${s.type}(${s.turns})`).join(", ")
    : "Status: none";
  const floorTag = game.isBossLevel ? " [BOSS FLOOR]" : game.isShopLevel ? " [SHOP]" : "";
  const lines = [
    `Depth: ${game.depth}${floorTag}   Turn: ${game.turn}   Gold: ${p.gold}`,
    `HP: ${p.hp}/${p.maxHp}   Lv: ${p.level}   XP: ${p.xp}/${p.xpNext}`,
    `STR: ${p.str}   DEF: ${p.def + armorDef}   Weapon: ${p.weapon.name}${p.weapon.ranged ? " (ranged, range " + p.weapon.range + ")" : ""}   Armor: ${p.armor ? p.armor.name : "None"}`,
    statusText
  ];
  if (game.isShopLevel) lines.push("Press B near the shopkeeper ($) to buy items.");
  if (game.won) lines.push("=== YOU WIN! You defeated the final boss! === Press F1 to play again.");
  else if (game.gameOver) lines.push("=== GAME OVER === Press F1 to restart.");
  document.getElementById("stats").textContent = lines.join("\n");
}

function renderInventory() {
  if (!game.invVisible) {
    document.getElementById("inv").textContent = "(Inventory hidden — press I to show)";
    return;
  }
  const lines = ["Inventory: (I to hide)"];
  game.player.inventory.forEach((it, i) => {
    let desc = it.name;
    if (it.type === "weapon") desc += ` (${it.dmgMin}-${it.dmgMax} dmg)`;
    if (it.type === "armor") desc += ` (def +${it.def})`;
    if (it.type === "potion") desc += ` (heal ${it.heal})`;
    lines.push(`  [${i}] ${desc}`);
  });
  if (game.player.inventory.length === 0) lines.push("  (empty)");
  document.getElementById("inv").textContent = lines.join("\n");
}

// ---------- Input ----------
window.addEventListener("keydown", (e) => {
  if (e.key === "F1") { e.preventDefault(); newGame(); render(); renderInventory(); return; }
  if (game.gameOver) return;

  const moveMap = {
    ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
    ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
    ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
    ArrowRight: [1, 0], d: [1, 0], D: [1, 0]
  };
  if (moveMap[e.key]) {
    e.preventDefault();
    tryMovePlayer(moveMap[e.key][0], moveMap[e.key][1]);
    return;
  }
  if (e.key === "i" || e.key === "I") { game.invVisible = !game.invVisible; renderInventory(); return; }
  if (e.key === "g" || e.key === "G") { pickupItem(); render(); renderInventory(); return; }
  if (e.key === "f" || e.key === "F") { playerShoot(); render(); return; }
  if (e.key === "r" || e.key === "R") { restPlayer(); render(); return; }
  if (e.key === ">" || e.key === ".") { tryDescend(); render(); return; }
  if (e.key === "e" || e.key === "E") {
    const n = prompt("Equip/use item number:");
    if (n !== null && !isNaN(parseInt(n))) useItem(parseInt(n));
    render();
    return;
  }
  if (e.key === "q" || e.key === "Q") {
    const n = prompt("Drop item number:");
    if (n !== null && !isNaN(parseInt(n))) dropItem(parseInt(n));
    render();
    return;
  }
  if (e.key === "b" || e.key === "B") {
    if (!game.shopkeeper || dist(game.player, game.shopkeeper) > 1.5) {
      addLog("There's no shopkeeper nearby.");
      render();
      return;
    }
    const list = game.shopStock.map((s, i) => `[${i}] ${s.item.name} - ${s.price}g`).join("\n");
    const n = prompt(`Shop (gold: ${game.player.gold}):\n${list}\n\nBuy item number:`);
    if (n !== null && !isNaN(parseInt(n))) buyItem(parseInt(n));
    render();
    return;
  }
});

// ---------- Boot ----------
newGame();
render();
renderInventory();
