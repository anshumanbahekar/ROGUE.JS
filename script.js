"use strict";

/* =========================================================
   ROGUE.JS — a single-file procedural dungeon crawler.
   Everything below is plain JavaScript: dungeon generation
   (BSP tree), recursive-shadowcasting field of view, A*
   pathfinding for monster AI, a turn-based combat/leveling
   system, procedural item/monster generation scaled by
   depth, an inventory & equipment system, and a tiny canvas
   renderer with zero styling beyond monospace green text.
   ========================================================= */

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
const TILE = { WALL: 0, FLOOR: 1, DOOR: 2, STAIRS_DOWN: 3, CHEST: 4 };

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
    return t === TILE.FLOOR || t === TILE.DOOR || t === TILE.STAIRS_DOWN || t === TILE.CHEST;
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
    for (let i = 1; i < this.rooms.length - 1; i++) {
      if (RNG.chance(0.25)) {
        const r = this.rooms[i];
        const cx = clamp(r.cx + RNG.int(-1, 1), r.x, r.x + r.w - 1);
        const cy = clamp(r.cy + RNG.int(-1, 1), r.y, r.y + r.h - 1);
        if (this.get(cx, cy) === TILE.FLOOR) this.set(cx, cy, TILE.CHEST);
      }
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

// ---------- Item generation ----------
const ITEM_TEMPLATES = {
  weapon: [
    { name: "Dagger", baseDmg: [2, 4], rarity: 1 },
    { name: "Short Sword", baseDmg: [3, 6], rarity: 1 },
    { name: "Long Sword", baseDmg: [5, 9], rarity: 2 },
    { name: "War Axe", baseDmg: [6, 12], rarity: 3 },
    { name: "Runic Blade", baseDmg: [9, 16], rarity: 4 }
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
  { name: "Skeleton", glyph: "s", hp: 18, atk: [3, 6], def: 2, xp: 14, minDepth: 2 },
  { name: "Orc", glyph: "o", hp: 26, atk: [4, 8], def: 3, xp: 22, minDepth: 3 },
  { name: "Wraith", glyph: "w", hp: 30, atk: [5, 9], def: 2, xp: 30, minDepth: 4 },
  { name: "Troll", glyph: "T", hp: 45, atk: [6, 12], def: 4, xp: 45, minDepth: 5 },
  { name: "Dragon Whelp", glyph: "D", hp: 60, atk: [8, 16], def: 6, xp: 80, minDepth: 7 }
];

function spawnMonster(depth, x, y) {
  const pool = MONSTER_TEMPLATES.filter(m => m.minDepth <= depth);
  const t = RNG.pick(pool);
  const scale = 1 + (depth - t.minDepth) * 0.12;
  return {
    name: t.name, glyph: t.glyph, x, y,
    hp: Math.round(t.hp * scale), maxHp: Math.round(t.hp * scale),
    atkMin: t.atk[0], atkMax: Math.round(t.atk[1] * scale),
    def: t.def, xp: Math.round(t.xp * scale),
    alive: true, lastSeenPlayer: null
  };
}

// ---------- Game State ----------
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
  gameOver: false
};

function newPlayer() {
  return {
    x: 0, y: 0, hp: 30, maxHp: 30, mp: 10, maxMp: 10,
    level: 1, xp: 0, xpNext: 20,
    str: 5, def: 2,
    weapon: { name: "Fists", dmgMin: 1, dmgMax: 3, type: "weapon" },
    armor: null,
    inventory: [],
    gold: 0
  };
}

function addLog(msg) {
  game.log.push(msg);
  if (game.log.length > 7) game.log.shift();
  document.getElementById("log").textContent = game.log.join("\n");
}

function newGame() {
  game.depth = 1;
  game.player = newPlayer();
  game.log = [];
  game.gameOver = false;
  addLog("You descend into the dungeon. Find the stairs (>) to go deeper.");
  enterLevel(1);
}

function enterLevel(depth) {
  game.depth = depth;
  const w = 60, h = 38;
  game.dungeon = new Dungeon(w, h, depth);
  game.player.x = game.dungeon.startRoom.cx;
  game.player.y = game.dungeon.startRoom.cy;
  game.monsters = [];
  game.items = [];
  game.visible = new Set();
  game.explored = new Set();

  const numMonsters = 4 + depth * 2;
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

// ---------- Combat ----------
function rollDamage(min, max) { return RNG.int(min, max); }

function playerAttack(monster) {
  const dmg = Math.max(1, rollDamage(game.player.weapon.dmgMin, game.player.weapon.dmgMax) + Math.floor(game.player.str / 3) - monster.def);
  monster.hp -= dmg;
  addLog(`You hit the ${monster.name} for ${dmg} damage.`);
  if (monster.hp <= 0) {
    monster.alive = false;
    addLog(`The ${monster.name} dies! +${monster.xp} XP`);
    gainXP(monster.xp);
  }
}

function monsterAttack(monster) {
  const playerDef = game.player.def + (game.player.armor ? game.player.armor.def : 0);
  const dmg = Math.max(1, rollDamage(monster.atkMin, monster.atkMax) - playerDef);
  game.player.hp -= dmg;
  addLog(`The ${monster.name} hits you for ${dmg} damage.`);
  if (game.player.hp <= 0) {
    game.player.hp = 0;
    game.gameOver = true;
    addLog(`You died on depth ${game.depth}. Press F1 to restart.`);
  }
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
  if (game.dungeon.isWalkable(nx, ny)) {
    game.player.x = nx; game.player.y = ny;
    const t = game.dungeon.get(nx, ny);
    if (t === TILE.CHEST) {
      const item = generateItem(game.depth);
      game.player.inventory.push(item);
      game.dungeon.set(nx, ny, TILE.FLOOR);
      addLog(`You open a chest and find: ${item.name}!`);
    }
    endTurn();
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
    const d = dist(m, game.player);
    const mk = key(m.x, m.y);
    const seesPlayer = game.visible.has(mk) && d < 9;
    if (seesPlayer) m.lastSeenPlayer = { x: game.player.x, y: game.player.y };

    if (d <= 1.4 && seesPlayer) {
      monsterAttack(m);
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

function endTurn() {
  game.turn++;
  monsterTurn();
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
    default: return " ";
  }
}

function render() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = (TS - 2) + "px monospace";
  ctx.textBaseline = "top";

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
      ctx.fillStyle = isVisible ? "#0f0" : "#063";
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
    ctx.fillStyle = "#f33";
    ctx.fillText(m.glyph, sx * TS, sy * TS);
  }

  const psx = game.player.x - camX, psy = game.player.y - camY;
  ctx.fillStyle = "#fff";
  ctx.fillText("@", psx * TS, psy * TS);

  renderStats();
}

function renderStats() {
  const p = game.player;
  const armorDef = p.armor ? p.armor.def : 0;
  const lines = [
    `Depth: ${game.depth}   Turn: ${game.turn}`,
    `HP: ${p.hp}/${p.maxHp}   Lv: ${p.level}   XP: ${p.xp}/${p.xpNext}`,
    `STR: ${p.str}   DEF: ${p.def + armorDef}   Weapon: ${p.weapon.name}   Armor: ${p.armor ? p.armor.name : "None"}`
  ];
  if (game.gameOver) lines.push("=== GAME OVER === Press F1 to restart.");
  document.getElementById("stats").textContent = lines.join("\n");
}

function renderInventory() {
  const lines = ["Inventory:"];
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
  if (e.key === "g" || e.key === "G") { pickupItem(); render(); renderInventory(); return; }
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
});

// ---------- Boot ----------
newGame();
render();
renderInventory();
