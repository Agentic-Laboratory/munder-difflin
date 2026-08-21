#!/usr/bin/env node
/**
 * Wizarding School map generator — authors
 * src/renderer/src/assets/maps/wizardschool.tmj
 *
 * A castle great hall: a high table across the head of the room (desk-ceo), four
 * long house tables split by a carpeted central aisle (pc-1..16), a potions
 * classroom off the east side (boardroom zone) and a common room with the hearth
 * and the tea trolley (cafeteria zone). Re-run after a layout tweak:
 *   node tools/gen-wizardschool-map.cjs
 *
 * GEOMETRY IS NOT FREE: OfficeFloor only attaches a DeskScreen when the seat
 * marker's off block sits at exactly (seat.x, seat.y - 2) on `furniture-above`
 * (OfficeFloor.tsx:1407). That forces tables to run EAST-WEST with benches along
 * their south edge — the same pod geometry as the office desks. Seats therefore
 * face 'up' and show their backs, exactly as in the office.
 *
 * A flood-fill validator asserts every seat / stand / coffee tile is reachable
 * from the entrance, and that every seat has a walkable approach, before write.
 */
const fs = require('fs');
const path = require('path');

const W = 38, H = 26, TS = 16;
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'maps', 'wizardschool.tmj');

// ── gid spaces ───────────────────────────────────────────────────────────────
const C = (i) => 2449 + i;   // wizardschool-castle.png (ours, original)
// office-tileset.png is embedded at firstgid 1, so its gids are literal. Only
// two pieces are borrowed from it — the wooden bookcase (2x2) and the armchairs.
const BOOKCASE = [[153, 154], [169, 170]];
const ARMCHAIR = [257, 258, 259, 260];

// castle atlas indices, by name (see WIZARDSCHOOL-ART.md)
const T = {
  floorA: 0, floorB: 1, floorCrack: 2, floorMoss: 3, slateA: 4, slateB: 5, warm: 6, stair: 7,
  rugL: 8, rugC: 9, rugR: 10, skyA: 11, skyB: 12, threshold: 13, rune: 14,
  wallA: 16, wallB: 17, cornice: 18, wallBase: 19, pillarTop: 20, pillarMid: 21, pillarBase: 22,
  wallDark: 23, plaque: 24, buttress: 25,
  winTL: 32, winTR: 33, winBL: 34, winBR: 35, glassTL: 36, glassTR: 37, glassBL: 38, glassBR: 39,
  archL: 40, archR: 41, doorL: 42, doorR: 43, portcullis: 44, passage: 45, slit: 46,
  bannerET: 48, bannerEB: 49, bannerNT: 50, bannerNB: 51,
  bannerST: 52, bannerSB: 53, bannerGT: 54, bannerGB: 55,
  rail: 56, hourglass: 57, tapT: 58, tapB: 59,
  torch: 64, candTop: 65, candBase: 66, floatCandles: 67, brazier: 68,
  hearthL: 69, hearthFire: 70, hearthR: 71,
  seatOffTL: 72, seatOffTR: 73, seatOnTL: 74, seatOnTR: 75, sconce: 76, lantern: 77,
  tableFar: 80, tableNear: 81, tablePlatter: 82, tableSetting: 83, tableEndL: 84, tableEndR: 85,
  bench: 86, benchEnd: 87,
  seatOffBL: 88, seatOffBR: 89, seatOnBL: 90, seatOnBR: 91,
  highFar: 92, highNear: 93, chair: 94, lectern: 95,
  cauldron: 96, cauldronLit: 97, potionShelf: 98, inkwell: 99, scrolls: 100, book: 101,
  crystal: 102, owl: 103, herbPot: 104, notice: 105, clock: 106,
  armourTop: 107, armourBot: 108, barrel: 109, broom: 110, pumpkin: 111,
};

// ── layer buffers ────────────────────────────────────────────────────────────
const mk = () => new Array(W * H).fill(0);
const L = { floor: mk(), walls: mk(), below: mk(), above: mk(), coll: mk() };
const idx = (x, y) => y * W + x;
const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const set = (layer, x, y, gid) => { if (inb(x, y)) L[layer][idx(x, y)] = gid; };
const solid = (x, y) => { if (inb(x, y)) L.coll[idx(x, y)] = 1; };
const clear = (x, y) => { if (inb(x, y)) L.coll[idx(x, y)] = 0; };

const hallFloor = (x, y) => {
  const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
  if (h % 23 === 0) return C(T.floorCrack);
  if (h % 29 === 0) return C(T.floorMoss);
  return ((x + y) % 2 === 0) ? C(T.floorA) : C(T.floorB);
};
const roomFloor = (x, y) => (((x + y) % 2 === 0) ? C(T.slateA) : C(T.slateB));

function wall(x, y) {
  set('walls', x, y, y === 0 ? C(T.cornice) : (((x + y) % 2) ? C(T.wallA) : C(T.wallB)));
  solid(x, y);
}

// ── 1. floors ────────────────────────────────────────────────────────────────
const HALL_X0 = 1, HALL_X1 = 24;       // great hall interior
const DIV_X = 25;                       // wall between hall and the east rooms
const EAST_X0 = 26, EAST_X1 = 36;
const DIV_Y = 12;                       // wall between classroom and common room
for (let y = 1; y < H - 1; y++) {
  for (let x = HALL_X0; x <= HALL_X1; x++) set('floor', x, y, hallFloor(x, y));
  for (let x = EAST_X0; x <= EAST_X1; x++) set('floor', x, y, roomFloor(x, y));
}
// carpeted central aisle, entrance -> high table
for (let y = 5; y <= H - 2; y++) { set('floor', 12, y, C(T.rugL)); set('floor', 13, y, C(T.rugR)); }

// ── 2. perimeter + dividers ──────────────────────────────────────────────────
for (let x = 0; x < W; x++) { wall(x, 0); wall(x, H - 1); }
for (let y = 0; y < H; y++) { wall(0, y); wall(W - 1, y); }
for (let y = 1; y <= H - 2; y++) wall(DIV_X, y);
for (let x = EAST_X0; x <= EAST_X1; x++) wall(x, DIV_Y);
// north wall band: base course under the cornice
for (let x = 1; x < W - 1; x++) { set('walls', x, 1, C(T.wallA)); set('walls', x, 2, C(T.wallBase)); solid(x, 1); solid(x, 2); }
// doors through the divider
const carve = (x, y, gid) => { set('walls', x, y, gid); clear(x, y); };
carve(DIV_X, 6, C(T.archL)); carve(DIV_X, 7, C(T.archR));       // -> classroom
carve(DIV_X, 18, C(T.archL)); carve(DIV_X, 19, C(T.archR));     // -> common room
// great doors, south wall
carve(12, H - 1, C(T.doorL)); carve(13, H - 1, C(T.doorR));
const ENTRANCE = { x: 12, y: H - 2 };

// ── 3. north wall dressing: windows, banners, a starry vault ─────────────────
const win = (x) => {
  set('walls', x, 1, C(T.winTL)); set('walls', x + 1, 1, C(T.winTR));
  set('walls', x, 2, C(T.winBL)); set('walls', x + 1, 2, C(T.winBR));
};
[3, 9, 15, 21].forEach(win);
const banner = (x, t, b) => { set('walls', x, 1, C(t)); set('walls', x, 2, C(b)); };
banner(6, T.bannerET, T.bannerEB);      // Emberwing
banner(12, T.bannerNT, T.bannerNB);     // Nightthistle
banner(18, T.bannerST, T.bannerSB);     // Skyquill
banner(23, T.bannerGT, T.bannerGB);     // Goldbriar
set('walls', 7, 1, C(T.skyB)); set('walls', 7, 2, C(T.skyA));   // open vault, night sky
set('walls', 8, 1, C(T.skyA)); set('walls', 8, 2, C(T.skyB));
[2, 11, 20].forEach((x) => set('above', x, 2, C(T.torch)));
// The clock is a CLICK TARGET, not decoration: OfficeFloor hangs the quit flow
// on ThemeConfig.anchors.clock and draws no art of its own, so without a tile
// here the closing-time prop is invisible. One tile, hence clockSize 16x16.
const PROPS = {
  clock: { x: 1, y: 1 },
  calendar: { x: 13, y: 1 },
  askMe: { x: 28, y: 1 },
  boards: { x: 28, y: 12 },
  boardStands: [{ x: 29, y: 13 }, { x: 31, y: 13 }, { x: 32, y: 13 }],
};
set('above', PROPS.clock.x, PROPS.clock.y, C(T.clock));

// ── 4. seat pods ─────────────────────────────────────────────────────────────
// The seat marker is a 2x2 block on `furniture-above` occupying (sx..sx+1,
// sy-2..sy-1) — the same shape and offset as the office's monitor block.
const SEATS = {};
function seatMarker(sx, sy) {
  set('above', sx, sy - 2, C(T.seatOffTL)); set('above', sx + 1, sy - 2, C(T.seatOffTR));
  set('above', sx, sy - 1, C(T.seatOffBL)); set('above', sx + 1, sy - 1, C(T.seatOffBR));
}

// high table + the headmaster's chair
const HIGH_Y = 3;
for (let x = 8; x <= 17; x++) {
  set('below', x, HIGH_Y, C(T.highFar)); set('below', x, HIGH_Y + 1, C(T.highNear));
  solid(x, HIGH_Y); solid(x, HIGH_Y + 1);
}
SEATS['desk-ceo'] = { x: 12, y: 5 };
set('below', 12, 5, C(T.chair));
seatMarker(12, 5);
set('above', 9, HIGH_Y + 1, C(T.lectern));
set('above', 15, HIGH_Y, C(T.candTop)); set('above', 15, HIGH_Y + 1, C(T.candBase));

// four house tables, split by the aisle at x=12..13
const HOUSE_Y = [7, 11, 15, 19];
const HALVES = [[2, 11], [14, 23]];
const SEAT_XS = [4, 8, 16, 20];
let pc = 0;
HOUSE_Y.forEach((ty) => {
  for (const [x0, x1] of HALVES) {
    for (let x = x0; x <= x1; x++) {
      set('below', x, ty, C(T.tableFar));
      set('below', x, ty + 1, x === x0 ? C(T.tableEndL) : x === x1 ? C(T.tableEndR) : C(T.tableNear));
      solid(x, ty); solid(x, ty + 1);
      set('below', x, ty + 2, x === x1 ? C(T.benchEnd) : C(T.bench));   // bench stays walkable
    }
  }
  // dressing on the free stretches of table (never over a seat marker)
  [3, 10, 15, 22].forEach((x, i) => set('above', x, ty, i % 2 ? C(T.tablePlatter) : C(T.tableSetting)));
  [6, 18].forEach((x) => { set('above', x, ty, C(T.candTop)); set('above', x, ty + 1, C(T.candBase)); });
  for (const sx of SEAT_XS) { pc += 1; SEATS[`pc-${pc}`] = { x: sx, y: ty + 2 }; seatMarker(sx, ty + 2); }
});

// ── 5. potions classroom (boardroom zone) ────────────────────────────────────
const bookcase = (x, y) => {
  BOOKCASE.forEach((row, ry) => row.forEach((gid, rx) => { set('below', x + rx, y + ry, gid); solid(x + rx, y + ry); }));
};
bookcase(34, 3);
set('above', 27, 3, C(T.lectern)); solid(27, 3);
set('above', 31, 3, C(T.potionShelf)); solid(31, 3);
set('above', 36, 3, C(T.armourTop)); set('above', 36, 4, C(T.armourBot)); solid(36, 3); solid(36, 4);
for (const [x0, x1] of [[27, 30], [32, 35]]) {
  for (let x = x0; x <= x1; x++) { set('below', x, 6, C(T.tableNear)); solid(x, 6); }
  set('above', x0 + 1, 6, C(T.cauldronLit));
  set('above', x1, 6, C(T.cauldron));
}
set('above', 29, 8, C(T.scrolls)); set('above', 33, 8, C(T.crystal));
set('above', 28, 11, C(T.herbPot)); solid(28, 11);
set('above', 35, 10, C(T.owl)); solid(35, 10);

// ── 6. common room (cafeteria zone) ──────────────────────────────────────────
set('below', 33, 13, C(T.hearthL)); set('below', 34, 13, C(T.hearthFire)); set('below', 35, 13, C(T.hearthR));
[33, 34, 35].forEach((x) => solid(x, 13));
set('below', 33, 15, ARMCHAIR[0]); set('below', 35, 15, ARMCHAIR[2]);
solid(33, 15); solid(35, 15);
bookcase(26, 13);
set('below', 28, 20, C(T.tableNear)); set('below', 29, 20, C(T.tableNear));
solid(28, 20); solid(29, 20);
set('above', 28, 20, C(T.book));
// tea trolley counter — the coffee economy's fixed tiles
for (let x = 30; x <= 35; x++) { set('below', x, 16, C(T.tableNear)); solid(x, 16); }
set('above', 30, 16, C(T.tablePlatter));   // trayTile   — the cup rack
set('above', 32, 16, C(T.cauldronLit));    // the trolley urn
set('above', 34, 16, C(T.tableSetting));   // sinkTile   — the wash basin
set('above', 36, 15, C(T.barrel)); solid(36, 15);   // pantry
set('above', 36, 19, C(T.barrel)); solid(36, 19);   // butterbeer casks
set('above', 27, 17, C(T.notice)); solid(27, 17);
set('above', 31, 22, C(T.pumpkin));
set('above', 34, 22, C(T.broom));
const COFFEE = {
  trayTile: { x: 30, y: 16 }, trayStand: { x: 30, y: 17 },
  machineTile: { x: 32, y: 16 }, machineStand: { x: 32, y: 17 },
  sinkTile: { x: 34, y: 16 }, sinkStand: { x: 34, y: 17 },
};
const CAFE = {
  'cafe-seat-1': { x: 28, y: 19 }, 'cafe-seat-2': { x: 28, y: 21 },
  'cafe-seat-3': { x: 29, y: 19 }, 'cafe-seat-4': { x: 29, y: 21 },
  'cafe-stand-coffee': { x: 33, y: 17 }, 'cafe-stand-vending': { x: 36, y: 20 },
};

// ── 7. errand props (each stand must stay walkable) ──────────────────────────
const prop = (x, y, t) => { set('above', x, y, C(t)); solid(x, y); };
prop(1, 6, T.herbPot); prop(24, 6, T.herbPot); prop(7, 4, T.herbPot);
prop(1, 23, T.barrel); prop(30, 24, T.barrel);
prop(24, 23, T.armourBot); set('above', 24, 22, C(T.armourTop)); solid(24, 22);
prop(26, 22, T.barrel);

// ── 8. spawn points + zones ──────────────────────────────────────────────────
const spawnObjs = [];
let oid = 1;
const addSpawn = (name, t) => spawnObjs.push({ id: oid++, name, point: true, x: t.x * TS, y: t.y * TS, width: 0, height: 0, rotation: 0, type: '', visible: true });
for (const [name, t] of Object.entries(SEATS)) addSpawn(name, t);
for (const [name, t] of Object.entries(CAFE)) addSpawn(name, t);
addSpawn('entrance', ENTRANCE);

const zoneObjs = [];
const addZone = (name, x, y, w, h) => zoneObjs.push({ id: oid++, name, x: x * TS, y: y * TS, width: w * TS, height: h * TS, rotation: 0, type: '', visible: true });
addZone('boardroom', 27, 4, 9, 7);    // potions classroom -> conference overflow
addZone('cafeteria', 26, 13, 11, 12); // common room -> breaks (declared for readability; the engine never reads it)

// ── 9. validate before writing ───────────────────────────────────────────────
const walk = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => L.coll[idx(x, y)] === 0));
const forceWalk = (t) => { if (inb(t.x, t.y)) walk[t.y][t.x] = true; };
Object.values(SEATS).forEach(forceWalk);   // runtime forces desk-/pc- spawns walkable
Object.values(CAFE).forEach(forceWalk);
Object.values(COFFEE).forEach(forceWalk);
forceWalk(ENTRANCE);

const seen = Array.from({ length: H }, () => Array(W).fill(false));
const q = [[ENTRANCE.x, ENTRANCE.y]]; seen[ENTRANCE.y][ENTRANCE.x] = true;
while (q.length) {
  const [x, y] = q.shift();
  for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
    if (inb(nx, ny) && !seen[ny][nx] && walk[ny][nx]) { seen[ny][nx] = true; q.push([nx, ny]); }
  }
}

const ERRANDS = [
  ['water', 2, 6], ['water', 23, 6], ['water', 28, 10], ['water', 7, 5],
  ['smoke', 3, 3], ['window', 4, 3], ['window', 22, 3],
  ['dispenser', 2, 23], ['dispenser', 30, 23], ['fridge', 36, 16],
  ['shelf', 31, 4], ['bin', 23, 23], ['bin', 27, 22],
];
const targets = [
  ...Object.entries(SEATS),
  ...Object.entries(CAFE),
  ...Object.entries(COFFEE).map(([n, t]) => [`coffee:${n}`, t]),
  ...ERRANDS.map(([k, x, y], i) => [`errand:${k}#${i}`, { x, y }]),
  // A board stand an actor cannot reach leaves findPath with nothing, and the
  // note-carrying choreography hangs until OfficeFloor's 30 s watchdog.
  ...PROPS.boardStands.map((t, i) => [`boardStand#${i}`, t]),
  ['entrance', ENTRANCE],
];
// Props hang ON a wall (or on the row directly under one). A prop over open
// floor renders as a board floating in mid-air with agents walking through it.
const floatingProp = Object.entries(PROPS)
  .filter(([n]) => n !== 'boardStands')
  .filter(([, t]) => !(L.walls[idx(t.x, t.y)] || (t.y > 0 && L.walls[idx(t.x, t.y - 1)])));
const unwalkableStand = PROPS.boardStands.filter((t) => !walk[t.y][t.x]);
const noClockArt = !L.above[idx(PROPS.clock.x, PROPS.clock.y)];
// The Graphics draw the mug rack, the basin and the steam OVER map art; with no
// art beneath them they float on bare floor.
const bareCoffee = ['trayTile', 'machineTile', 'sinkTile']
  .filter((k) => !(L.below[idx(COFFEE[k].x, COFFEE[k].y)] || L.above[idx(COFFEE[k].x, COFFEE[k].y)]));
const unreachable = targets.filter(([, t]) => !(inb(t.x, t.y) && seen[t.y][t.x]));
const noApproach = Object.entries(SEATS).filter(([, s]) =>
  ![[s.x, s.y + 1], [s.x, s.y - 1], [s.x + 1, s.y], [s.x - 1, s.y]]
    .some(([ax, ay]) => inb(ax, ay) && walk[ay][ax] && seen[ay] && seen[ay][ax]));
// Every seat must carry the marker's off block at exactly (sx, sy-2) or the
// spellbook never lights — the check that a silent gid slip would otherwise hide.
const noMarker = Object.entries(SEATS).filter(([, s]) =>
  L.above[idx(s.x, s.y - 2)] !== C(T.seatOffTL) || L.above[idx(s.x + 1, s.y - 2)] !== C(T.seatOffTR) ||
  L.above[idx(s.x, s.y - 1)] !== C(T.seatOffBL) || L.above[idx(s.x + 1, s.y - 1)] !== C(T.seatOffBR));
// Every painted gid must resolve inside one of the four declared atlases.
const RANGES = [[1, 512], [513, 512], [1025, 1424], [2449, 112]];
const badGid = [];
for (const [name, buf] of Object.entries(L)) {
  if (name === 'coll') continue;
  buf.forEach((g, i) => {
    if (!g) return;
    if (!RANGES.some(([f, n]) => g >= f && g < f + n)) badGid.push(`${name}@${i % W},${Math.floor(i / W)}=${g}`);
  });
}

if (unreachable.length || noApproach.length || noMarker.length || badGid.length
    || floatingProp.length || unwalkableStand.length || noClockArt || bareCoffee.length) {
  console.error('VALIDATION FAILED');
  if (unreachable.length) console.error('  unreachable:', unreachable.map(([n]) => n).join(', '));
  if (noApproach.length) console.error('  no walkable approach:', noApproach.map(([n]) => n).join(', '));
  if (noMarker.length) console.error('  seat marker missing/misplaced:', noMarker.map(([n]) => n).join(', '));
  if (badGid.length) console.error('  gid outside every atlas:', badGid.slice(0, 8).join(', '));
  if (floatingProp.length) console.error('  prop not on a wall:', floatingProp.map(([n]) => n).join(', '));
  if (unwalkableStand.length) console.error('  board stand inside collision:', JSON.stringify(unwalkableStand));
  if (noClockArt) console.error('  no clock art at anchors.clock — the quit prop would be invisible');
  if (bareCoffee.length) console.error('  coffee object tile with no art beneath it:', bareCoffee.join(', '));
  process.exit(1);
}

// ── 10. write the .tmj ───────────────────────────────────────────────────────
const tileLayer = (name, data, id) => ({ id, name, type: 'tilelayer', data, width: W, height: H, x: 0, y: 0, opacity: 1, visible: true });
const map = {
  compressionlevel: -1, infinite: false, orientation: 'orthogonal', renderorder: 'right-down',
  width: W, height: H, tilewidth: TS, tileheight: TS, nextlayerid: 99, nextobjectid: oid,
  version: '1.10', tiledversion: '1.10.2', type: 'map',
  // Index order must match ThemeConfig.tilesets — themeLoader pairs them
  // positionally (texture[i] <-> tilesets[i]) and keeps the map's own copy only
  // for the embedded first atlas.
  tilesets: [
    { firstgid: 1, columns: 16, image: '../tilesets/office-tileset.png', imageheight: 512, imagewidth: 256, margin: 0, name: 'office-tileset', spacing: 0, tilecount: 512, tileheight: 16, tilewidth: 16 },
    { firstgid: 513, source: 'A5 Office Floors & Walls.tsx' },
    { firstgid: 1025, source: 'interiors.tsx' },
    { firstgid: 2449, columns: 16, image: '../tilesets/wizardschool-castle.png', imageheight: 112, imagewidth: 256, margin: 0, name: 'wizardschool-castle', spacing: 0, tilecount: 112, tileheight: 16, tilewidth: 16 },
  ],
  layers: [
    tileLayer('floor', L.floor, 1),
    tileLayer('walls', L.walls, 2),
    tileLayer('furniture-below', L.below, 3),
    tileLayer('furniture-above', L.above, 4),
    tileLayer('collision', L.coll, 5),
    { id: 6, name: 'spawn-points', type: 'objectgroup', objects: spawnObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 },
    { id: 7, name: 'zones', type: 'objectgroup', objects: zoneObjs, draworder: 'topdown', opacity: 1, visible: true, x: 0, y: 0 },
  ],
};
fs.writeFileSync(OUT, JSON.stringify(map));
console.log(`OK wrote ${path.relative(path.join(__dirname, '..'), OUT)} — ${W}x${H}, ${Object.keys(SEATS).length} seats, ${Object.keys(CAFE).length} cafe spawns, zones: boardroom/cafeteria`);
console.log(`   validation: reachability, seat approach, seat markers, gid ranges, prop anchors, board stands, coffee art all OK`);
