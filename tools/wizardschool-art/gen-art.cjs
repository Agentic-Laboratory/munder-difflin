#!/usr/bin/env node
/*
 * gen-art.cjs — Wizarding School office theme: ORIGINAL pixel art generator.
 *
 * Emits, with ZERO external deps (pure Node `zlib` PNG encoder):
 *   src/renderer/src/assets/tilesets/wizardschool-castle.png
 *     256x112, 16x16 tiles, 16 cols, tilecount 112. Appended to the office gid
 *     space at firstgid 2449 (= 1025 + 1424, immediately after `interiors`).
 *
 * Every pixel is authored here from scratch. Nothing is copied, traced or
 * recolored from another tileset, so this atlas carries no third-party licence
 * (unlike the vendored LimeZu art — see assets/ATTRIBUTION.md). Deterministic:
 * re-run to rebuild byte-identically.
 *
 * The atlas deliberately draws only what the vendored atlases LACK — stone,
 * arches, banners, flame, refectory tables. Benches, bookshelves, the fireplace,
 * framed portraits and cauldron-ish pots already exist in `interiors.png` and are
 * referenced from there by the map rather than redrawn here.
 *
 * Tile index table: assets/tilesets/WIZARDSCHOOL-ART.md (authoritative).
 *
 * Run:  node tools/wizardschool-art/gen-art.cjs
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ── PNG encoder (8-bit RGBA, filter 0) ───────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── canvas helper ─────────────────────────────────────────────────────────────
function Canvas(w, h) {
  const data = Buffer.alloc(w * h * 4); // transparent
  const set = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= w || y >= h || !c) return;
    const a = c[3] === undefined ? 255 : c[3];
    const i = (y * w + x) * 4;
    if (a >= 255) { data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; return; }
    const sa = a / 255, da = data[i + 3] / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    data[i] = Math.round((c[0] * sa + data[i] * da * (1 - sa)) / oa);
    data[i + 1] = Math.round((c[1] * sa + data[i + 1] * da * (1 - sa)) / oa);
    data[i + 2] = Math.round((c[2] * sa + data[i + 2] * da * (1 - sa)) / oa);
    data[i + 3] = Math.round(oa * 255);
  };
  const rect = (x, y, rw, rh, c) => { for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) set(xx, yy, c); };
  const hline = (x0, x1, y, c) => { for (let x = x0; x <= x1; x++) set(x, y, c); };
  const vline = (x, y0, y1, c) => { for (let y = y0; y <= y1; y++) set(x, y, c); };
  return { w, h, data, set, rect, hline, vline };
}

// ── palette ───────────────────────────────────────────────────────────────────
const lt = (c, d) => [Math.min(255, c[0] + d), Math.min(255, c[1] + d), Math.min(255, c[2] + d)];
const dk = (c, d) => [Math.max(0, c[0] - d), Math.max(0, c[1] - d), Math.max(0, c[2] - d)];

const P = {
  // The masonry ramps are WARM (R > G > B) — honey sandstone lit by candles, not
  // slate. They were originally cool blue-greys, which made the hall read as a
  // crypt: every warm thing in the room (banners, candelabra, the aisle carpet,
  // the oak tables) was fighting the walls instead of sitting in them. The night
  // sky, the window glass and the ambient `glow` stay cool on purpose — the
  // contrast against warm stone is what sells candlelight, and warming those too
  // turns the whole atlas orange and kills the enchanted ceiling.
  stone: [138, 116, 90], stoneSh: [106, 86, 64], stoneHi: [166, 144, 114], stoneDk: [80, 64, 47],
  mortar: [66, 52, 39],
  // Vertical masonry is a separate, darker ramp from the floor paving. With one
  // shared tone the wall line vanishes into the floor and the room loses its edges.
  wall: [112, 92, 69], wallSh: [86, 68, 50], wallHi: [136, 114, 88],
  wallDk: [66, 52, 39], wallJoint: [49, 38, 28],
  // The east rooms (potions classroom, common room) are floored in slate rather
  // than the hall's paving, so it must stay a DIFFERENT material — but in the
  // same warm family, or the two halves of the castle read as two buildings.
  slate: [112, 96, 80], slateSh: [86, 72, 58], slateHi: [136, 118, 100],
  warm: [142, 120, 102], warmHi: [170, 148, 128], warmSh: [110, 90, 74],
  wood: [122, 82, 52], woodSh: [92, 60, 38], woodHi: [150, 106, 68], oak: [80, 52, 34],
  gold: [214, 176, 84], goldSh: [168, 132, 54], goldHi: [240, 214, 138],
  // Warm-neutral rather than blue-grey: sconces and hinges sit ON the honey
  // stone, and a cool iron read as a second, competing grey against it.
  iron: [96, 88, 82], ironSh: [70, 63, 58], ironHi: [130, 122, 114],
  flame: [246, 186, 74], flameHi: [255, 236, 168], flameSh: [214, 112, 42],
  night: [26, 28, 54], nightHi: [48, 52, 92], star: [236, 232, 196],
  crimson: [138, 34, 44], crimsonSh: [98, 20, 30], crimsonHi: [176, 58, 62],
  green: [30, 86, 58], greenSh: [18, 60, 40], greenHi: [52, 118, 78],
  blue: [42, 66, 124], blueSh: [26, 44, 90], blueHi: [70, 100, 160],
  amber: [190, 132, 40], amberSh: [142, 94, 24], amberHi: [220, 168, 70],
  silver: [190, 194, 204], bronze: [162, 116, 66],
  parch: [228, 214, 178], parchSh: [196, 178, 140],
  glass: [110, 146, 172], glassHi: [172, 204, 220],
  wax: [238, 232, 214], waxSh: [206, 196, 172],
  moss: [86, 112, 62],
  glow: [176, 214, 240], glowHi: [226, 242, 252],
};

// ── geometry helpers ──────────────────────────────────────────────────────────
const TILE = 16, ATLAS_COLS = 16, ATLAS_ROWS = 7;
function tilePos(idx) { return [(idx % ATLAS_COLS) * TILE, Math.floor(idx / ATLAS_COLS) * TILE]; }

/** Deterministic speckle (no Math.random — the atlas must rebuild identically). */
function speck(cv, x, y, n, c, seed) {
  for (let i = 0; i < n; i++) {
    const h = (i * 7919 + seed * 104729) >>> 0;
    cv.set(x + (h % 16), y + ((h >> 5) % 16), c);
  }
}

/** Flagstone paving seen from ABOVE: discrete bevelled slabs with mortar joints
 *  on every side. Deliberately NOT a brick-course pattern with full-width
 *  highlight stripes — that reads as a vertical wall, not a floor. */
const SLABS_A = [[0, 0, 8, 8], [8, 0, 8, 8], [0, 8, 5, 8], [5, 8, 11, 8]];
const SLABS_B = [[0, 0, 5, 8], [5, 0, 11, 8], [0, 8, 8, 8], [8, 8, 8, 8]];
const SLABS_C = [[0, 0, 11, 7], [11, 0, 5, 7], [0, 7, 6, 9], [6, 7, 10, 9]];
function flag(cv, x, y, base, joint, hi, slabs, seed) {
  cv.rect(x, y, 16, 16, base);
  slabs.forEach((s, i) => {
    const t = (((i * 2654435761) + seed * 40503) >>> 0) % 5 - 2;
    const c = [base[0] + t * 4, base[1] + t * 4, base[2] + t * 5];
    cv.rect(x + s[0], y + s[1], s[2], s[3], c);
    cv.hline(x + s[0], x + s[0] + s[2] - 1, y + s[1], hi);           // bevel: lit top
    cv.vline(x + s[0], y + s[1], y + s[1] + s[3] - 1, hi);           // bevel: lit left
    cv.hline(x + s[0], x + s[0] + s[2] - 1, y + s[1] + s[3] - 1, joint);
    cv.vline(x + s[0] + s[2] - 1, y + s[1], y + s[1] + s[3] - 1, joint);
  });
}

/** Big ashlar blocks for vertical wall faces. */
function wallFace(cv, x, y, base, joint, hi, off) {
  cv.rect(x, y, 16, 16, base);
  cv.hline(x, x + 15, y + 5, joint);
  cv.hline(x, x + 15, y + 11, joint);
  cv.vline(x + (off % 16), y, y + 4, joint);
  cv.vline(x + ((off + 9) % 16), y + 6, y + 10, joint);
  cv.vline(x + ((off + 4) % 16), y + 12, y + 15, joint);
  cv.hline(x, x + 15, y + 6, hi);
  cv.hline(x, x + 15, y + 12, hi);
  cv.hline(x, x + 15, y, hi);
}

/** Arch inner edge: how far down the glass starts, per column, for a 2-tile-wide
 *  round arch whose springing is the seam between the two tiles. */
function archTopY(col, side) {
  const dx = side === 'L' ? 15.5 - col : col + 0.5;
  const v = 196 - dx * dx;
  return v <= 0 ? 99 : Math.round(16 - Math.sqrt(v));
}

/** Leaded pane fill with a diamond lattice. */
function pane(cv, x, y, x0, x1, y0, y1, base, hi, lead) {
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) cv.set(x + px, y + py, base);
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
    if (((px + py) % 6) === 0 || ((px - py + 60) % 6) === 0) cv.set(x + px, y + py, lead);
  }
  for (let i = 0; i < 4; i++) { cv.set(x + x0 + 1 + i, y + y0 + 1 + i, hi); cv.set(x + x0 + 2 + i, y + y0 + 1 + i, hi); }
}

// ── tiles ─────────────────────────────────────────────────────────────────────
const TILES = {};

// row 0 — floors 0..14
TILES[0] = (cv, x, y) => { flag(cv, x, y, P.stone, P.mortar, P.stoneHi, SLABS_A, 1); speck(cv, x, y, 5, P.stoneSh, 1); };
TILES[1] = (cv, x, y) => { flag(cv, x, y, P.stone, P.mortar, P.stoneHi, SLABS_B, 2); speck(cv, x, y, 5, P.stoneSh, 2); };
TILES[2] = (cv, x, y) => { // cracked
  flag(cv, x, y, P.stone, P.mortar, P.stoneHi, SLABS_C, 3);
  for (let i = 0; i < 7; i++) cv.set(x + 4 + i, y + 3 + ((i * 3) % 5), P.stoneDk);
  speck(cv, x, y, 6, P.stoneSh, 3);
};
TILES[3] = (cv, x, y) => { // mossy
  flag(cv, x, y, P.stone, P.mortar, P.stoneHi, SLABS_A, 4);
  speck(cv, x, y, 9, P.moss, 4); speck(cv, x, y, 4, dk(P.moss, 20), 5);
};
TILES[4] = (cv, x, y) => { flag(cv, x, y, P.slate, dk(P.slateSh, 14), P.slateHi, SLABS_B, 6); speck(cv, x, y, 4, P.slateSh, 6); };
TILES[5] = (cv, x, y) => { flag(cv, x, y, P.slate, dk(P.slateSh, 14), P.slateHi, SLABS_C, 7); speck(cv, x, y, 4, P.slateSh, 7); };
TILES[6] = (cv, x, y) => { flag(cv, x, y, P.warm, dk(P.warmSh, 18), P.warmHi, SLABS_A, 8); speck(cv, x, y, 4, P.warmSh, 8); };
TILES[7] = (cv, x, y) => { // stair tread
  cv.rect(x, y, 16, 16, P.stone);
  for (const ty of [1, 6, 11]) { cv.hline(x, x + 15, y + ty, P.stoneHi); cv.hline(x, x + 15, y + ty + 4, P.mortar); }
  cv.rect(x, y + 15, 16, 1, P.stoneDk);
};
TILES[8] = (cv, x, y) => { // carpet runner, left edge
  cv.rect(x, y, 16, 16, P.stone); cv.hline(x, x + 15, y + 7, P.mortar);
  cv.rect(x + 4, y, 12, 16, P.crimson); cv.vline(x + 4, y, y + 15, P.crimsonSh);
  cv.vline(x + 6, y, y + 15, P.gold); cv.vline(x + 7, y, y + 15, P.goldSh);
};
TILES[9] = (cv, x, y) => { // carpet runner, centre
  cv.rect(x, y, 16, 16, P.crimson);
  for (let i = 0; i < 4; i++) cv.hline(x, x + 15, y + 1 + i * 4, P.crimsonHi);
  cv.set(x + 4, y + 3, P.gold); cv.set(x + 11, y + 11, P.gold);
};
TILES[10] = (cv, x, y) => { // carpet runner, right edge
  cv.rect(x, y, 16, 16, P.stone); cv.hline(x, x + 15, y + 7, P.mortar);
  cv.rect(x, y, 12, 16, P.crimson); cv.vline(x + 11, y, y + 15, P.crimsonSh);
  cv.vline(x + 8, y, y + 15, P.gold); cv.vline(x + 9, y, y + 15, P.goldSh);
};
TILES[11] = (cv, x, y) => { // enchanted ceiling — deep night
  cv.rect(x, y, 16, 16, P.night);
  for (let i = 0; i < 5; i++) { const h = (i * 6151) >>> 0; cv.set(x + (h % 16), y + ((h >> 5) % 16), P.nightHi); }
};
TILES[12] = (cv, x, y) => { // enchanted ceiling — stars
  cv.rect(x, y, 16, 16, P.night);
  const pts = [[2, 3], [7, 1], [12, 5], [4, 9], [10, 12], [14, 9], [6, 14]];
  for (const [sx, sy] of pts) {
    cv.set(x + sx, y + sy, P.star);
    cv.set(x + sx - 1, y + sy, dk(P.star, 90)); cv.set(x + sx + 1, y + sy, dk(P.star, 90));
    cv.set(x + sx, y + sy - 1, dk(P.star, 90)); cv.set(x + sx, y + sy + 1, dk(P.star, 90));
  }
};
TILES[13] = (cv, x, y) => { // doorway threshold
  cv.rect(x, y, 16, 16, P.warm);
  cv.hline(x, x + 15, y, P.stoneDk); cv.hline(x, x + 15, y + 1, P.warmHi);
  cv.hline(x, x + 15, y + 15, P.warmSh); speck(cv, x, y, 5, P.warmSh, 9);
};
TILES[14] = (cv, x, y) => { // rune circle on stone
  flag(cv, x, y, P.slate, dk(P.slateSh, 14), P.slateHi, SLABS_B, 9);
  const ring = [[5, 2], [8, 2], [10, 3], [12, 5], [13, 8], [12, 11], [10, 13], [8, 14], [5, 14], [3, 13], [2, 11], [1, 8], [2, 5], [3, 3]];
  for (const [rx, ry] of ring) cv.set(x + rx, y + ry, P.glow);
  cv.rect(x + 6, y + 6, 4, 4, P.glowHi); cv.set(x + 7, y + 7, P.glow); cv.set(x + 8, y + 8, P.glow);
};

// row 1 — walls 16..25
TILES[16] = (cv, x, y) => { wallFace(cv, x, y, P.wall, P.wallJoint, P.wallHi, 4); speck(cv, x, y, 4, P.wallSh, 11); };
TILES[17] = (cv, x, y) => { wallFace(cv, x, y, P.wall, P.wallJoint, P.wallHi, 12); speck(cv, x, y, 4, P.wallSh, 12); };
TILES[18] = (cv, x, y) => { // top cornice
  cv.rect(x, y, 16, 16, P.wall);
  cv.rect(x, y, 16, 3, P.wallHi); cv.hline(x, x + 15, y + 3, P.wallDk);
  cv.rect(x, y + 4, 16, 2, lt(P.wall, 10)); cv.hline(x, x + 15, y + 6, P.wallJoint);
  wallFace(cv, x, y + 8, P.wall, P.wallJoint, P.wallHi, 4);
  cv.rect(x, y + 16, 16, 0, null);
};
TILES[19] = (cv, x, y) => { // base skirting
  wallFace(cv, x, y, P.wall, P.wallJoint, P.wallHi, 8);
  cv.rect(x, y + 12, 16, 4, P.wallSh); cv.hline(x, x + 15, y + 12, P.wallDk);
  cv.hline(x, x + 15, y + 15, dk(P.wallDk, 14));
};
TILES[20] = (cv, x, y) => { // pillar top
  cv.rect(x + 2, y + 4, 12, 12, P.wall);
  cv.rect(x + 1, y, 14, 4, P.wallHi); cv.hline(x + 1, x + 14, y + 4, P.wallDk);
  cv.vline(x + 2, y + 5, y + 15, P.wallHi); cv.vline(x + 13, y + 5, y + 15, P.wallSh);
};
TILES[21] = (cv, x, y) => { // pillar body
  cv.rect(x + 2, y, 12, 16, P.wall);
  cv.vline(x + 2, y, y + 15, P.wallHi); cv.vline(x + 3, y, y + 15, lt(P.wall, 8));
  cv.vline(x + 12, y, y + 15, P.wallSh); cv.vline(x + 13, y, y + 15, P.wallDk);
  cv.hline(x + 2, x + 13, y + 8, P.wallJoint);
};
TILES[22] = (cv, x, y) => { // pillar base
  cv.rect(x + 2, y, 12, 10, P.wall);
  cv.vline(x + 2, y, y + 9, P.wallHi); cv.vline(x + 13, y, y + 9, P.wallSh);
  cv.rect(x + 1, y + 10, 14, 4, P.wallSh); cv.hline(x + 1, x + 14, y + 10, P.wallHi);
  cv.hline(x, x + 15, y + 14, P.wallDk); cv.hline(x, x + 15, y + 15, P.wallJoint);
};
TILES[23] = (cv, x, y) => { wallFace(cv, x, y, P.wallSh, dk(P.wallJoint, 10), P.wall, 6); };
TILES[24] = (cv, x, y) => { // wall plaque
  wallFace(cv, x, y, P.wall, P.wallJoint, P.wallHi, 4);
  cv.rect(x + 3, y + 4, 10, 8, P.bronze); cv.rect(x + 4, y + 5, 8, 6, dk(P.bronze, 34));
  cv.hline(x + 5, x + 10, y + 7, P.goldHi); cv.hline(x + 5, x + 9, y + 9, P.gold);
};
TILES[25] = (cv, x, y) => { // buttress rib
  wallFace(cv, x, y, P.wall, P.wallJoint, P.wallHi, 2);
  cv.rect(x + 5, y, 6, 16, lt(P.wall, 12));
  cv.vline(x + 5, y, y + 15, P.wallHi); cv.vline(x + 10, y, y + 15, P.wallSh);
};

// ── row 2 — openings 32..46 ───────────────────────────────────────────────────
/** One light of a two-light arched window. `part` = TL|TR|BL|BR. */
function lancet(cv, x, y, part, paneBase, paneHi, lead) {
  const side = (part === 'TL' || part === 'BL') ? 'L' : 'R';
  const frameCols = side === 'L' ? [0, 1] : [14, 15];   // outer jamb
  const mullCol = side === 'L' ? 15 : 0;                // seam mullion
  const isTop = part[0] === 'T';
  for (let col = 0; col < 16; col++) {
    const inFrame = frameCols.includes(col) || col === mullCol;
    const yTop = isTop ? archTopY(col, side) : 0;
    for (let row = 0; row < 16; row++) {
      if (inFrame) { cv.set(x + col, y + row, (col === mullCol) ? P.wall : P.wallHi); continue; }
      if (isTop && row < yTop) cv.set(x + col, y + row, P.wall);
    }
  }
  // glass field
  const gx0 = side === 'L' ? 2 : 1, gx1 = side === 'L' ? 14 : 13;
  for (let col = gx0; col <= gx1; col++) {
    const yTop = isTop ? archTopY(col, side) : 0;
    if (yTop > 15) { for (let r = 0; r < 16; r++) cv.set(x + col, y + r, P.wall); continue; }
    const yBot = isTop ? 15 : 13;
    for (let row = Math.max(0, yTop); row <= yBot; row++) {
      const litter = ((col + row) % 6 === 0 || (col - row + 60) % 6 === 0) ? lead : paneBase;
      cv.set(x + col, y + row, litter);
    }
    if (isTop) cv.set(x + col, y + Math.max(0, yTop), P.wallDk); // arch soffit line
  }
  if (isTop) { for (let i = 0; i < 4; i++) { cv.set(x + gx0 + 2 + i, y + 6 + i, paneHi); cv.set(x + gx0 + 3 + i, y + 6 + i, paneHi); } }
  else {
    for (let i = 0; i < 3; i++) { cv.set(x + gx0 + 2 + i, y + 2 + i, paneHi); cv.set(x + gx0 + 3 + i, y + 2 + i, paneHi); }
    cv.rect(x, y + 14, 16, 2, P.wall);           // sill
    cv.hline(x, x + 15, y + 14, P.wallHi);
    cv.hline(x, x + 15, y + 15, P.wallSh);
  }
}
TILES[32] = (cv, x, y) => lancet(cv, x, y, 'TL', P.night, P.glassHi, P.ironSh);
TILES[33] = (cv, x, y) => lancet(cv, x, y, 'TR', P.night, P.glassHi, P.ironSh);
TILES[34] = (cv, x, y) => lancet(cv, x, y, 'BL', P.night, P.glassHi, P.ironSh);
TILES[35] = (cv, x, y) => lancet(cv, x, y, 'BR', P.night, P.glassHi, P.ironSh);
// stained variants — same tracery, house-coloured glass
TILES[36] = (cv, x, y) => { lancet(cv, x, y, 'TL', P.crimson, P.goldHi, P.ironSh); };
TILES[37] = (cv, x, y) => { lancet(cv, x, y, 'TR', P.blue, P.glassHi, P.ironSh); };
TILES[38] = (cv, x, y) => { lancet(cv, x, y, 'BL', P.green, P.silver, P.ironSh); };
TILES[39] = (cv, x, y) => { lancet(cv, x, y, 'BR', P.amber, P.goldHi, P.ironSh); };

TILES[40] = (cv, x, y) => { // doorway arch, left half
  for (let col = 0; col < 16; col++) {
    const yTop = archTopY(col, 'L');
    for (let row = 0; row < 16; row++) {
      if (row < yTop) cv.set(x + col, y + row, P.wall);
      else cv.set(x + col, y + row, dk(P.night, 8));
    }
    if (yTop <= 15) { cv.set(x + col, y + yTop, P.wallHi); cv.set(x + col, y + yTop + 1, P.wallDk); }
  }
  cv.rect(x, y, 2, 16, P.wallHi);
};
TILES[41] = (cv, x, y) => { // doorway arch, right half
  for (let col = 0; col < 16; col++) {
    const yTop = archTopY(col, 'R');
    for (let row = 0; row < 16; row++) {
      if (row < yTop) cv.set(x + col, y + row, P.wall);
      else cv.set(x + col, y + row, dk(P.night, 8));
    }
    if (yTop <= 15) { cv.set(x + col, y + yTop, P.wallHi); cv.set(x + col, y + yTop + 1, P.wallDk); }
  }
  cv.rect(x + 14, y, 2, 16, P.wallSh);
};
TILES[42] = (cv, x, y) => { // studded oak door, left leaf
  cv.rect(x + 1, y, 15, 16, P.wood);
  for (const px of [3, 7, 11]) cv.vline(x + px, y, y + 15, P.woodSh);
  for (const px of [4, 8, 12]) cv.vline(x + px, y, y + 15, P.woodHi);
  cv.rect(x + 1, y + 3, 15, 2, P.iron); cv.rect(x + 1, y + 11, 15, 2, P.iron);
  cv.hline(x + 1, x + 15, y + 3, P.ironHi); cv.hline(x + 1, x + 15, y + 11, P.ironHi);
  for (const px of [3, 8, 13]) { cv.set(x + px, y + 4, P.ironHi); cv.set(x + px, y + 12, P.ironHi); }
  cv.vline(x + 1, y, y + 15, P.oak);
};
TILES[43] = (cv, x, y) => { // studded oak door, right leaf + ring handle
  cv.rect(x, y, 15, 16, P.wood);
  for (const px of [3, 7, 11]) cv.vline(x + px, y, y + 15, P.woodSh);
  for (const px of [4, 8, 12]) cv.vline(x + px, y, y + 15, P.woodHi);
  cv.rect(x, y + 3, 15, 2, P.iron); cv.rect(x, y + 11, 15, 2, P.iron);
  cv.hline(x, x + 14, y + 3, P.ironHi); cv.hline(x, x + 14, y + 11, P.ironHi);
  for (const px of [2, 7, 12]) { cv.set(x + px, y + 4, P.ironHi); cv.set(x + px, y + 12, P.ironHi); }
  cv.rect(x + 1, y + 7, 3, 1, P.ironHi); cv.rect(x + 1, y + 6, 1, 2, P.iron); cv.rect(x + 4, y + 6, 1, 2, P.iron);
  cv.vline(x + 14, y, y + 15, P.oak);
};
TILES[44] = (cv, x, y) => { // portcullis
  cv.rect(x, y, 16, 16, dk(P.night, 10));
  for (let px = 1; px < 16; px += 4) { cv.rect(x + px, y, 2, 16, P.iron); cv.vline(x + px, y, y + 15, P.ironHi); }
  for (const py of [3, 11]) { cv.rect(x, y + py, 16, 2, P.ironSh); cv.hline(x, x + 15, y + py, P.iron); }
};
TILES[45] = (cv, x, y) => { cv.rect(x, y, 16, 16, dk(P.night, 12)); speck(cv, x, y, 3, P.night, 21); };
TILES[46] = (cv, x, y) => { // arrow-slit window
  wallFace(cv, x, y, P.wall, P.wallJoint, P.wallHi, 4);
  cv.rect(x + 6, y + 2, 4, 12, P.wallDk);
  cv.rect(x + 7, y + 3, 2, 10, P.night);
  cv.set(x + 7, y + 5, P.glassHi); cv.set(x + 8, y + 6, P.glassHi);
};

// ── row 3 — banners 48..59 ────────────────────────────────────────────────────
const CRESTS = {
  wing: (cv, x, y, c) => { for (let i = 0; i < 4; i++) { cv.set(x + 5 + i, y + 9 - i, c); cv.set(x + 10 - i, y + 9 - i, c); } cv.rect(x + 7, y + 9, 2, 3, c); },
  thistle: (cv, x, y, c) => { cv.rect(x + 7, y + 5, 2, 3, c); for (let i = 0; i < 3; i++) { cv.hline(x + 6 - i, x + 9 + i, y + 8 + i, c); } cv.rect(x + 7, y + 11, 2, 2, c); },
  quill: (cv, x, y, c) => { for (let i = 0; i < 7; i++) cv.set(x + 6 + Math.floor(i / 2), y + 5 + i, c); cv.hline(x + 5, x + 8, y + 6, c); cv.hline(x + 5, x + 7, y + 8, c); cv.rect(x + 8, y + 11, 2, 2, c); },
  briar: (cv, x, y, c) => { const r = [[6, 6], [7, 5], [8, 5], [9, 6], [10, 8], [9, 10], [8, 11], [7, 11], [6, 10], [5, 8]]; for (const [rx, ry] of r) cv.set(x + rx, y + ry, c); cv.set(x + 4, y + 7, c); cv.set(x + 11, y + 9, c); },
};
/** `part`='T' hangs from a rail with a crest; 'B' tapers to a fringed point. */
function banner(cv, x, y, part, cloth, trim, crest) {
  if (part === 'T') {
    cv.rect(x, y, 16, 2, P.gold); cv.hline(x, x + 15, y, P.goldHi); cv.hline(x, x + 15, y + 1, P.goldSh);
    cv.rect(x + 2, y + 2, 12, 14, cloth);
    cv.rect(x + 2, y + 2, 2, 14, trim); cv.rect(x + 12, y + 2, 2, 14, trim);
    cv.vline(x + 4, y + 2, y + 15, lt(cloth, 18));
    cv.hline(x + 2, x + 13, y + 2, dk(cloth, 26));
    if (crest) CRESTS[crest](cv, x, y, trim === P.silver ? P.silver : P.goldHi);
  } else {
    cv.rect(x + 2, y, 12, 9, cloth);
    cv.rect(x + 2, y, 2, 9, trim); cv.rect(x + 12, y, 2, 9, trim);
    cv.vline(x + 4, y, y + 8, lt(cloth, 18));
    const taper = [[3, 12], [4, 11], [5, 10], [6, 9], [7, 8]];
    taper.forEach(([x0, x1], i) => {
      for (let px = x0; px <= x1; px++) cv.set(x + px, y + 9 + i, cloth);
      cv.set(x + x0, y + 9 + i, trim); cv.set(x + x1, y + 9 + i, trim);
    });
    cv.set(x + 7, y + 14, P.goldHi); cv.set(x + 8, y + 14, P.goldHi);
  }
}
TILES[48] = (cv, x, y) => banner(cv, x, y, 'T', P.crimson, P.gold, 'wing');      // Gryffindor
TILES[49] = (cv, x, y) => banner(cv, x, y, 'B', P.crimson, P.gold);
TILES[50] = (cv, x, y) => banner(cv, x, y, 'T', P.green, P.silver, 'thistle');   // Slytherin
TILES[51] = (cv, x, y) => banner(cv, x, y, 'B', P.green, P.silver);
TILES[52] = (cv, x, y) => banner(cv, x, y, 'T', P.blue, P.bronze, 'quill');      // Ravenclaw
TILES[53] = (cv, x, y) => banner(cv, x, y, 'B', P.blue, P.bronze);
TILES[54] = (cv, x, y) => banner(cv, x, y, 'T', P.amber, P.oak, 'briar');        // Hufflepuff
TILES[55] = (cv, x, y) => banner(cv, x, y, 'B', P.amber, P.oak);
TILES[56] = (cv, x, y) => { cv.rect(x, y, 16, 3, P.gold); cv.hline(x, x + 15, y, P.goldHi); cv.hline(x, x + 15, y + 2, P.goldSh); };
TILES[57] = (cv, x, y) => { // house-points hourglass
  cv.rect(x + 3, y + 1, 10, 2, P.wood); cv.rect(x + 3, y + 13, 10, 2, P.wood);
  for (let i = 0; i < 5; i++) { cv.hline(x + 4 + i, x + 11 - i, y + 3 + i, P.glass); }
  for (let i = 0; i < 5; i++) { cv.hline(x + 4 + (4 - i), x + 11 - (4 - i), y + 8 + i, P.glass); }
  cv.rect(x + 5, y + 10, 6, 3, P.goldHi); cv.set(x + 7, y + 7, P.gold); cv.set(x + 8, y + 8, P.gold);
};
TILES[58] = (cv, x, y) => { // tapestry, top
  cv.rect(x, y, 16, 2, P.oak);
  cv.rect(x + 1, y + 2, 14, 14, dk(P.crimson, 30));
  cv.rect(x + 3, y + 5, 10, 8, P.amberSh); cv.rect(x + 5, y + 7, 6, 4, P.gold);
  cv.vline(x + 1, y + 2, y + 15, P.gold); cv.vline(x + 14, y + 2, y + 15, P.gold);
};
TILES[59] = (cv, x, y) => { // tapestry, bottom
  cv.rect(x + 1, y, 14, 13, dk(P.crimson, 30));
  cv.vline(x + 1, y, y + 12, P.gold); cv.vline(x + 14, y, y + 12, P.gold);
  cv.rect(x + 4, y + 2, 8, 5, P.greenSh);
  cv.hline(x + 1, x + 14, y + 13, P.gold);
  for (let px = 2; px < 15; px += 3) cv.rect(x + px, y + 14, 2, 2, P.goldSh);
};

// ── row 4/5 — the seat marker (replaces the office desk monitor) ──────────────
// A self-writing spellbook. DeskScreen overlays the ON block and animates
// scrolling pale-blue lines inside a HARDCODED rect (SCREEN = x3,y5,w25,h12 of
// the 2x2 block, DeskScreen.ts:25) that no MonitorConfig field can move — so the
// open pages are drawn to sit exactly there and the animation reads as text
// writing itself onto the page.
//
// Laid out as two 2x2 blocks side by side, exactly like the office tileset's
// off/on monitor pair: OFF at 72,73 / 88,89 and ON at 74,75 / 90,91.
function blockCanvas(fn) { const c = Canvas(32, 32); fn(c); return c; }
function blit(cv, x, y, src, sx, sy) {
  for (let r = 0; r < 16; r++) for (let q = 0; q < 16; q++) {
    const i = ((sy + r) * src.w + (sx + q)) * 4;
    const a = src.data[i + 3];
    if (!a) continue;
    cv.set(x + q, y + r, [src.data[i], src.data[i + 1], src.data[i + 2], a]);
  }
}
function bookShadow(c) {
  c.rect(4, 19, 24, 2, [70, 48, 32, 120]);
  c.rect(6, 21, 20, 1, [70, 48, 32, 70]);
}
function drawSeatOff(c) {
  bookShadow(c);
  c.rect(5, 6, 22, 13, P.oak);                       // cover board
  c.rect(6, 7, 20, 11, dk(P.crimson, 46));           // leather inlay
  c.hline(6, 25, 7, dk(P.crimson, 20));
  for (let px = 8; px <= 23; px++) { c.set(px, 9, P.goldSh); c.set(px, 15, P.goldSh); }
  for (let py = 9; py <= 15; py++) { c.set(8, py, P.goldSh); c.set(23, py, P.goldSh); }
  c.rect(14, 11, 4, 3, P.gold); c.set(15, 12, P.goldHi);   // rune boss
  c.vline(26, 7, 18, P.parchSh); c.hline(6, 26, 18, P.parchSh); // page edges
  c.hline(5, 26, 6, lt(P.oak, 26));
  c.rect(25, 12, 3, 2, P.gold);                      // clasp
}
function drawSeatOn(c) {
  bookShadow(c);
  // Splayed covers. This silhouette must fully contain drawSeatOff's, or the
  // closed cover peeks out from under the overlay while an agent is seated.
  c.rect(2, 4, 28, 16, P.oak);
  c.rect(3, 5, 26, 14, dk(P.oak, 16));
  c.rect(3, 5, 25, 12, P.parch);                     // page field == SCREEN
  c.rect(4, 6, 23, 10, P.glowHi);
  c.rect(15, 5, 2, 12, P.parchSh); c.vline(15, 5, 16, dk(P.parchSh, 30)); // spine
  c.hline(4, 13, 5, P.glow); c.hline(18, 26, 5, P.glow);
  c.hline(3, 28, 17, P.parchSh); c.hline(3, 28, 18, dk(P.parchSh, 40));
  c.rect(6, 2, 20, 2, [176, 214, 240, 70]);          // enchanted spill
  c.rect(10, 0, 12, 2, [176, 214, 240, 40]);
  for (const [mx, my] of [[8, 1], [15, 0], [22, 1], [12, 2], [19, 2]]) c.set(mx, my, P.glowHi);
}
const SEAT_OFF = blockCanvas(drawSeatOff);
const SEAT_ON = blockCanvas(drawSeatOn);
TILES[72] = (cv, x, y) => blit(cv, x, y, SEAT_OFF, 0, 0);
TILES[73] = (cv, x, y) => blit(cv, x, y, SEAT_OFF, 16, 0);
TILES[88] = (cv, x, y) => blit(cv, x, y, SEAT_OFF, 0, 16);
TILES[89] = (cv, x, y) => blit(cv, x, y, SEAT_OFF, 16, 16);
TILES[74] = (cv, x, y) => blit(cv, x, y, SEAT_ON, 0, 0);
TILES[75] = (cv, x, y) => blit(cv, x, y, SEAT_ON, 16, 0);
TILES[90] = (cv, x, y) => blit(cv, x, y, SEAT_ON, 0, 16);
TILES[91] = (cv, x, y) => blit(cv, x, y, SEAT_ON, 16, 16);

// ── row 4 — flame + light 64..71, 76..77 ──────────────────────────────────────
/** Slim teardrop. `small` (3px wide, 4 tall) is for tiles carrying several
 *  flames — at 16px, three full-size flames merge into one shapeless mass. */
function flameShape(cv, x, y, cx, base, small) {
  const prof = small ? [0, 0, 1, 1] : [0, 0, 1, 1, 2, 1];   // half-width, tip -> base
  prof.forEach((w, i) => {
    const py = base - (prof.length - 1) + i;
    for (let d = -w; d <= w; d++) cv.set(x + cx + d, y + py, i <= 1 ? P.flameHi : P.flame);
  });
  cv.set(x + cx, y + base, P.flameSh);
  if (!small) { cv.set(x + cx - 1, y + base, P.flameSh); cv.set(x + cx + 1, y + base, P.flameSh); }
  cv.rect(x + cx - (small ? 1 : 2), y + base - (prof.length - 1), small ? 3 : 5, prof.length, [246, 186, 74, 18]);
}
TILES[64] = (cv, x, y) => { // wall torch, lit
  cv.rect(x + 6, y + 9, 4, 3, P.iron); cv.hline(x + 6, x + 9, y + 9, P.ironHi);
  cv.rect(x + 5, y + 11, 6, 2, P.ironSh);
  cv.rect(x + 7, y + 6, 2, 5, P.wood); cv.vline(x + 7, y + 6, y + 10, P.woodHi);
  flameShape(cv, x, y, 8, 6);
};
TILES[65] = (cv, x, y) => { // candelabra, top (three lit candles)
  cv.rect(x + 2, y + 9, 12, 2, P.gold); cv.hline(x + 2, x + 13, y + 9, P.goldHi);
  for (const [cx, top] of [[3, 6], [8, 3], [13, 6]]) {
    cv.rect(x + cx - 1, y + top, 2, 9 - top, P.wax); cv.vline(x + cx - 1, y + top, y + 8, P.waxSh);
    flameShape(cv, x, y, cx, top, true);
  }
  cv.rect(x + 7, y + 11, 2, 5, P.goldSh);
};
TILES[66] = (cv, x, y) => { // candelabra, base
  cv.rect(x + 7, y, 2, 10, P.goldSh); cv.vline(x + 7, y, y + 9, P.gold);
  cv.rect(x + 5, y + 10, 6, 2, P.gold);
  cv.rect(x + 3, y + 12, 10, 2, P.goldSh); cv.hline(x + 3, x + 12, y + 12, P.gold);
  cv.rect(x + 2, y + 14, 12, 1, dk(P.goldSh, 40));
};
TILES[67] = (cv, x, y) => { // floating candles
  for (const [cx, cy] of [[4, 9], [11, 12]]) {
    cv.rect(x + cx - 1, y + cy, 2, 4, P.wax); cv.vline(x + cx - 1, y + cy, y + cy + 3, P.waxSh);
    flameShape(cv, x, y, cx, cy, true);
  }
};
TILES[68] = (cv, x, y) => { // brazier
  cv.rect(x + 3, y + 8, 10, 4, P.iron); cv.hline(x + 3, x + 12, y + 8, P.ironHi);
  cv.rect(x + 4, y + 12, 8, 2, P.ironSh);
  cv.rect(x + 6, y + 14, 4, 2, P.ironSh);
  for (const [cx, b] of [[5, 8], [8, 6], [11, 8]]) flameShape(cv, x, y, cx, b, true);
};
TILES[69] = (cv, x, y) => { // hearth, left jamb
  cv.rect(x + 2, y, 14, 16, P.stone);
  cv.rect(x + 2, y, 4, 16, P.stoneHi); cv.vline(x + 6, y, y + 15, P.stoneDk);
  cv.rect(x + 7, y + 2, 9, 14, dk(P.night, 12));
  cv.hline(x + 2, x + 15, y, P.stoneHi); cv.hline(x + 7, x + 15, y + 2, P.stoneDk);
};
TILES[70] = (cv, x, y) => { // hearth, fire
  cv.rect(x, y, 16, 16, dk(P.night, 12));
  cv.hline(x, x + 15, y + 2, P.stoneDk);
  cv.rect(x + 1, y + 12, 14, 2, P.oak);
  for (const [cx, b] of [[4, 12], [8, 9], [12, 12]]) flameShape(cv, x, y, cx, b, true);
  cv.rect(x + 2, y + 6, 12, 6, [246, 186, 74, 34]);
};
TILES[71] = (cv, x, y) => { // hearth, right jamb
  cv.rect(x, y, 14, 16, P.stone);
  cv.rect(x + 10, y, 4, 16, P.stoneSh); cv.vline(x + 9, y, y + 15, P.stoneDk);
  cv.rect(x, y + 2, 9, 14, dk(P.night, 12));
  cv.hline(x, x + 13, y, P.stoneHi); cv.hline(x, x + 8, y + 2, P.stoneDk);
};
TILES[76] = (cv, x, y) => { // sconce, unlit
  cv.rect(x + 6, y + 9, 4, 3, P.ironSh); cv.hline(x + 6, x + 9, y + 9, P.iron);
  cv.rect(x + 7, y + 5, 2, 5, P.wax); cv.vline(x + 7, y + 5, y + 9, P.waxSh);
  cv.set(x + 7, y + 4, P.stoneDk);
};
TILES[77] = (cv, x, y) => { // hanging lantern
  cv.rect(x + 7, y, 2, 3, P.ironSh);
  cv.rect(x + 4, y + 3, 8, 2, P.iron); cv.hline(x + 4, x + 11, y + 3, P.ironHi);
  cv.rect(x + 5, y + 5, 6, 7, P.glass);
  cv.vline(x + 5, y + 5, y + 11, P.ironSh); cv.vline(x + 10, y + 5, y + 11, P.ironSh);
  flameShape(cv, x, y, 8, 11);
  cv.rect(x + 4, y + 12, 8, 2, P.iron);
};

// ── row 5 — refectory tables + benches 80..87, 92..95 ─────────────────────────
// Tables run EAST-WEST, two tiles deep, benches along the south edge. That is
// the office desk-pod geometry (see DESK_STAMP in the map generator) and it is
// what makes the seat marker work: OfficeFloor only attaches a DeskScreen when
// the off block sits at exactly (seat.x, seat.y - 2).
function tableTop(cv, x, y) {
  cv.rect(x, y, 16, 16, P.wood);
  cv.hline(x, x + 15, y + 4, P.woodSh); cv.hline(x, x + 15, y + 10, P.woodSh);
  cv.hline(x, x + 15, y + 5, P.woodHi); cv.hline(x, x + 15, y + 11, P.woodHi);
}
TILES[80] = (cv, x, y) => { // table, far row
  tableTop(cv, x, y);
  cv.hline(x, x + 15, y, P.oak); cv.hline(x, x + 15, y + 1, P.woodHi);
};
TILES[81] = (cv, x, y) => { // table, near row (apron + contact shadow)
  tableTop(cv, x, y);
  cv.rect(x, y + 12, 16, 3, P.woodSh); cv.hline(x, x + 15, y + 12, P.oak);
  cv.hline(x, x + 15, y + 15, dk(P.oak, 24));
};
TILES[82] = (cv, x, y) => { // far row + platter
  TILES[80](cv, x, y);
  cv.rect(x + 3, y + 7, 10, 5, P.silver); cv.hline(x + 3, x + 12, y + 7, lt(P.silver, 30));
  cv.rect(x + 5, y + 8, 6, 3, P.amberSh); cv.set(x + 6, y + 9, P.amberHi); cv.set(x + 9, y + 9, P.crimson);
};
TILES[83] = (cv, x, y) => { // near row + place setting
  TILES[81](cv, x, y);
  cv.rect(x + 2, y + 5, 6, 5, P.parch); cv.rect(x + 3, y + 6, 4, 3, P.parchSh);
  cv.rect(x + 10, y + 3, 3, 5, P.gold); cv.rect(x + 10, y + 8, 3, 1, P.goldSh);
  cv.rect(x + 11, y + 9, 1, 2, P.goldSh); cv.rect(x + 10, y + 11, 3, 1, P.goldSh);
};
TILES[84] = (cv, x, y) => { TILES[81](cv, x, y); cv.vline(x, y, y + 15, P.oak); cv.vline(x + 1, y, y + 15, P.woodSh); };
TILES[85] = (cv, x, y) => { TILES[81](cv, x, y); cv.vline(x + 15, y, y + 15, P.oak); cv.vline(x + 14, y, y + 15, P.woodSh); };
TILES[86] = (cv, x, y) => { // bench, middle
  cv.rect(x, y + 6, 16, 4, P.wood); cv.hline(x, x + 15, y + 6, P.woodHi);
  cv.hline(x, x + 15, y + 9, P.woodSh);
  cv.rect(x + 2, y + 10, 2, 5, P.woodSh); cv.rect(x + 12, y + 10, 2, 5, P.woodSh);
  cv.hline(x, x + 15, y + 15, [40, 30, 24, 90]);
};
TILES[87] = (cv, x, y) => { // bench, end
  TILES[86](cv, x, y);
  cv.vline(x + 15, y + 6, y + 9, P.oak);
};
TILES[92] = (cv, x, y) => { // high table, far row
  cv.rect(x, y, 16, 16, P.oak);
  cv.hline(x, x + 15, y, dk(P.oak, 22)); cv.hline(x, x + 15, y + 1, lt(P.oak, 30));
  cv.hline(x, x + 15, y + 6, P.gold); cv.hline(x, x + 15, y + 7, P.goldSh);
  cv.hline(x, x + 15, y + 12, dk(P.oak, 14));
};
TILES[93] = (cv, x, y) => { // high table, near row
  cv.rect(x, y, 16, 16, P.oak);
  cv.hline(x, x + 15, y + 3, P.gold); cv.hline(x, x + 15, y + 4, P.goldSh);
  cv.rect(x, y + 12, 16, 3, dk(P.oak, 22)); cv.hline(x, x + 15, y + 12, P.goldSh);
  cv.hline(x, x + 15, y + 15, dk(P.oak, 40));
};
TILES[94] = (cv, x, y) => { // high-backed carved chair
  cv.rect(x + 3, y, 10, 11, P.oak); cv.hline(x + 3, x + 12, y, P.gold);
  cv.rect(x + 5, y + 2, 6, 6, dk(P.crimson, 30));
  cv.rect(x + 7, y + 4, 2, 2, P.gold);
  cv.rect(x + 2, y + 11, 12, 3, P.wood); cv.hline(x + 2, x + 13, y + 11, P.woodHi);
  cv.rect(x + 3, y + 14, 2, 2, P.woodSh); cv.rect(x + 11, y + 14, 2, 2, P.woodSh);
};
TILES[95] = (cv, x, y) => { // lectern
  cv.rect(x + 3, y + 2, 10, 4, P.oak); cv.hline(x + 3, x + 12, y + 2, P.woodHi);
  cv.rect(x + 4, y + 3, 8, 2, P.parch);
  cv.rect(x + 7, y + 6, 2, 8, P.woodSh);
  cv.rect(x + 4, y + 14, 8, 2, P.oak); cv.hline(x + 4, x + 11, y + 14, P.wood);
};

// ── row 6 — props 96..111 ─────────────────────────────────────────────────────
TILES[96] = (cv, x, y) => { // cauldron
  cv.rect(x + 3, y + 5, 10, 2, P.ironSh); cv.hline(x + 3, x + 12, y + 5, P.iron);
  cv.rect(x + 2, y + 7, 12, 5, P.ironSh);
  cv.rect(x + 4, y + 12, 8, 1, dk(P.ironSh, 20));
  cv.vline(x + 3, y + 7, y + 11, P.iron);
  for (const lx of [4, 8, 11]) cv.rect(x + lx, y + 13, 2, 3, dk(P.ironSh, 26));
};
TILES[97] = (cv, x, y) => { // cauldron, bubbling
  TILES[96](cv, x, y);
  cv.rect(x + 4, y + 6, 8, 2, P.greenHi);
  cv.set(x + 5, y + 4, P.greenHi); cv.set(x + 8, y + 2, P.greenHi); cv.set(x + 11, y + 3, P.greenHi);
  cv.set(x + 7, y + 5, lt(P.greenHi, 40)); cv.rect(x + 3, y + 1, 10, 5, [52, 118, 78, 34]);
};
TILES[98] = (cv, x, y) => { // potion shelf
  cv.rect(x, y + 10, 16, 3, P.oak); cv.hline(x, x + 15, y + 10, P.wood);
  const cols = [P.greenHi, P.crimsonHi, P.blueHi, P.amberHi, P.glow];
  cols.forEach((c, i) => {
    const bx = x + 1 + i * 3;
    cv.rect(bx, y + 5, 2, 5, c); cv.set(bx, y + 5, lt(c, 40));
    cv.set(bx, y + 4, P.iron);
  });
};
TILES[99] = (cv, x, y) => { // inkwell + quill
  cv.rect(x + 3, y + 10, 5, 4, P.iron); cv.hline(x + 3, x + 7, y + 10, P.ironHi);
  cv.rect(x + 4, y + 11, 3, 2, dk(P.night, 6));
  for (let i = 0; i < 7; i++) cv.set(x + 8 + i, y + 10 - i, P.parch);
  cv.set(x + 13, y + 4, P.parchSh); cv.set(x + 14, y + 3, P.parchSh);
};
TILES[100] = (cv, x, y) => { // scroll stack
  for (let i = 0; i < 3; i++) {
    const py = y + 12 - i * 3;
    cv.rect(x + 2 + i, py, 12 - i * 2, 3, P.parch);
    cv.hline(x + 2 + i, x + 13 - i, py, lt(P.parch, 20));
    cv.set(x + 2 + i, py + 1, P.parchSh); cv.set(x + 13 - i, py + 1, P.parchSh);
  }
  cv.rect(x + 5, y + 3, 6, 1, P.crimson);
};
TILES[101] = (cv, x, y) => { // spellbook, closed (decor)
  cv.rect(x + 3, y + 8, 11, 5, P.oak);
  cv.rect(x + 4, y + 9, 9, 3, dk(P.blue, 10));
  cv.hline(x + 4, x + 12, y + 9, P.blueHi);
  cv.rect(x + 7, y + 10, 3, 1, P.gold);
  cv.vline(x + 13, y + 9, y + 12, P.parchSh);
};
TILES[102] = (cv, x, y) => { // crystal ball
  cv.rect(x + 5, y + 11, 6, 2, P.goldSh); cv.rect(x + 4, y + 13, 8, 2, P.gold);
  const ring = [[6, 4], [9, 4], [11, 6], [11, 9], [9, 11], [6, 11], [4, 9], [4, 6]];
  cv.rect(x + 5, y + 5, 6, 6, P.glow);
  for (const [rx, ry] of ring) cv.set(x + rx, y + ry, P.glow);
  cv.rect(x + 6, y + 6, 2, 2, P.glowHi);
};
TILES[103] = (cv, x, y) => { // owl on a perch
  cv.rect(x + 2, y + 11, 12, 2, P.wood); cv.hline(x + 2, x + 13, y + 11, P.woodHi);
  cv.rect(x + 6, y + 5, 5, 6, P.warmSh); cv.rect(x + 7, y + 6, 3, 4, P.parchSh);
  cv.set(x + 7, y + 6, P.amberHi); cv.set(x + 9, y + 6, P.amberHi);
  cv.set(x + 8, y + 7, P.amberSh);
  cv.set(x + 6, y + 4, P.warmSh); cv.set(x + 10, y + 4, P.warmSh);
};
TILES[104] = (cv, x, y) => { // herbology pot
  cv.rect(x + 4, y + 9, 8, 6, P.bronze); cv.hline(x + 4, x + 11, y + 9, lt(P.bronze, 30));
  cv.rect(x + 3, y + 8, 10, 2, dk(P.bronze, 24));
  for (const [lx, ly] of [[5, 5], [7, 3], [9, 4], [11, 6]]) {
    cv.rect(x + lx, y + ly, 2, 4, P.moss); cv.set(x + lx, y + ly, lt(P.moss, 34));
  }
  cv.rect(x + 7, y + 6, 2, 3, dk(P.moss, 18));
};
TILES[105] = (cv, x, y) => { // notice board
  cv.rect(x + 1, y + 1, 14, 14, P.oak);
  cv.rect(x + 2, y + 2, 12, 12, [176, 134, 88]);
  speck(cv, x + 2, y + 2, 8, [146, 108, 68], 31);
  cv.rect(x + 3, y + 3, 4, 4, P.parch); cv.rect(x + 9, y + 4, 4, 4, P.parch);
  cv.rect(x + 5, y + 9, 5, 4, P.parch);
  cv.set(x + 4, y + 3, P.crimson); cv.set(x + 10, y + 4, P.crimson); cv.set(x + 6, y + 9, P.crimson);
};
TILES[106] = (cv, x, y) => { // great clock
  cv.rect(x + 2, y + 2, 12, 12, P.gold);
  cv.rect(x + 3, y + 3, 10, 10, P.parch);
  for (const [hx, hy] of [[8, 3], [8, 12], [3, 8], [12, 8]]) cv.set(x + hx, y + hy, P.oak);
  cv.vline(x + 8, y + 5, y + 8, P.oak); cv.hline(x + 8, x + 10, y + 8, P.oak);
  cv.set(x + 8, y + 8, P.crimson);
};
TILES[107] = (cv, x, y) => { // suit of armour, top
  cv.rect(x + 6, y + 3, 4, 4, P.silver); cv.hline(x + 6, x + 9, y + 3, lt(P.silver, 30));
  cv.rect(x + 7, y + 5, 2, 1, P.ironSh);
  cv.rect(x + 4, y + 7, 8, 6, P.silver); cv.vline(x + 4, y + 7, y + 12, P.iron);
  cv.vline(x + 11, y + 7, y + 12, P.iron); cv.vline(x + 8, y + 7, y + 12, P.ironHi);
  cv.rect(x + 2, y + 8, 2, 5, P.iron); cv.rect(x + 12, y + 8, 2, 5, P.iron);
};
TILES[108] = (cv, x, y) => { // suit of armour, bottom
  cv.rect(x + 4, y, 8, 3, P.silver); cv.vline(x + 8, y, y + 2, P.ironHi);
  cv.rect(x + 4, y + 3, 3, 9, P.iron); cv.rect(x + 9, y + 3, 3, 9, P.iron);
  cv.vline(x + 4, y + 3, y + 11, P.silver); cv.vline(x + 9, y + 3, y + 11, P.silver);
  cv.rect(x + 3, y + 12, 5, 2, P.ironSh); cv.rect(x + 8, y + 12, 5, 2, P.ironSh);
  cv.rect(x + 2, y + 14, 12, 1, [40, 30, 24, 90]);
};
TILES[109] = (cv, x, y) => { // barrel
  cv.rect(x + 3, y + 4, 10, 11, P.wood);
  cv.vline(x + 3, y + 4, y + 14, P.woodSh); cv.vline(x + 12, y + 4, y + 14, P.woodSh);
  cv.vline(x + 6, y + 4, y + 14, P.woodHi);
  cv.rect(x + 3, y + 6, 10, 1, P.iron); cv.rect(x + 3, y + 12, 10, 1, P.iron);
  cv.rect(x + 4, y + 3, 8, 2, P.oak); cv.hline(x + 4, x + 11, y + 3, P.wood);
};
TILES[110] = (cv, x, y) => { // broom
  for (let i = 0; i < 9; i++) cv.set(x + 4 + i, y + 12 - i, P.wood);
  for (let i = 0; i < 9; i++) cv.set(x + 5 + i, y + 12 - i, P.woodSh);
  cv.rect(x + 2, y + 11, 4, 4, P.amberSh);
  for (const bx of [2, 3, 4, 5]) cv.set(x + bx, y + 15, P.amber);
  cv.rect(x + 3, y + 10, 3, 2, dk(P.amberSh, 22));
};
TILES[111] = (cv, x, y) => { // pumpkin
  cv.rect(x + 3, y + 7, 10, 7, P.amber);
  cv.vline(x + 3, y + 8, y + 13, P.amberSh); cv.vline(x + 12, y + 8, y + 13, P.amberSh);
  cv.vline(x + 6, y + 7, y + 13, P.amberHi); cv.vline(x + 9, y + 7, y + 13, P.amberSh);
  cv.hline(x + 4, x + 11, y + 7, P.amberHi); cv.hline(x + 4, x + 11, y + 14, P.amberSh);
  cv.rect(x + 7, y + 5, 2, 2, P.moss);
};

// ── emit ──────────────────────────────────────────────────────────────────────
function buildTileset() {
  const cv = Canvas(ATLAS_COLS * TILE, ATLAS_ROWS * TILE);
  for (const [idx, fn] of Object.entries(TILES)) {
    const i = +idx;
    if (i >= ATLAS_COLS * ATLAS_ROWS) throw new Error(`tile ${i} is outside the ${ATLAS_COLS}x${ATLAS_ROWS} atlas`);
    const [x, y] = tilePos(i);
    fn(cv, x, y);
  }
  return { png: encodePNG(cv.w, cv.h, cv.data), w: cv.w, h: cv.h };
}

function main() {
  const root = path.resolve(__dirname, '..', '..');
  const out = path.join(root, 'src/renderer/src/assets/tilesets/wizardschool-castle.png');
  const { png, w, h } = buildTileset();
  fs.writeFileSync(out, png);
  const drawn = Object.keys(TILES).length;
  const total = ATLAS_COLS * ATLAS_ROWS;
  console.log(`OK wrote ${path.relative(root, out)} — ${w}x${h}, ${drawn}/${total} tiles drawn`);
  console.log(`   TilesetEntry: firstgid 2449, columns ${ATLAS_COLS}, imagewidth ${w}, imageheight ${h}, tilecount ${total}`);
  console.log(`   monitor.offTopLeftGid = ${2449 + 72}`);
  console.log(`   monitor.onGids = [[${2449 + 74},0,0],[${2449 + 75},1,0],[${2449 + 90},0,1],[${2449 + 91},1,1]]`);
}
main();
