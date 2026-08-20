'use strict';
// The .tmj <-> ThemeConfig contract is enforced entirely by string matching at
// runtime: a misspelled spawn name, a seat marker one tile out, or a gid past the
// end of an atlas all fail SILENTLY — no type error, no exception, just a floor
// with no coffee economy or a desk that never lights up. These assertions are the
// only thing standing between that and a shipped theme.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'src/renderer/src');
const GID_MASK = 0x1fffffff;

// Minimal loader for renderer TS: resolves the `@/` alias, turns Vite's ?raw /
// ?url asset imports into plain strings, and stubs pixi (cast.ts imports Texture
// as a value). esbuild's synchronous API cannot take plugins, and pulling in the
// async one would mean restructuring the whole file around a promise.
const cache = new Map();
const toFs = (req, dir) => (req.startsWith('@/') ? path.join(R, req.slice(2)) : path.resolve(dir, req));
function resolveTsFile(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
function loadModule(filename) {
  const hit = cache.get(filename);
  if (hit) return hit.exports;
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  });
  const mod = { exports: {} };
  cache.set(filename, mod);
  const dir = path.dirname(filename);
  const localRequire = (request) => {
    if (request === 'pixi.js') return { Texture: class Texture {} };
    const asset = /^(.*)\?(raw|url)$/.exec(request);
    if (asset) {
      const p = toFs(asset[1], dir);
      return asset[2] === 'raw' ? fs.readFileSync(p, 'utf8') : `stub://${path.basename(p)}`;
    }
    if (request.startsWith('@/') || request.startsWith('.')) {
      const resolved = resolveTsFile(toFs(request, dir));
      if (resolved) return loadModule(resolved);
    }
    return require(request);
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__filename', '__dirname', out.outputText)(
    mod, mod.exports, localRequire, filename, dir,
  );
  return mod.exports;
}
const loadRegistry = () => loadModule(path.join(R, 'scene/office/themeRegistry.ts'));

const { THEMES } = loadRegistry();
const themeIds = Object.keys(THEMES);

test('every declared theme id is registered with a config', () => {
  assert.ok(themeIds.length >= 3, `expected at least office/brooklyn99/wizardschool, got ${themeIds}`);
  assert.ok(themeIds.includes('wizardschool'), 'wizardschool must be registered');
});

for (const id of themeIds) {
  const theme = THEMES[id];
  const map = JSON.parse(theme.mapRaw);
  const layer = (name, type) => map.layers.find((l) => l.name === name && l.type === type);
  const tileAt = (name, x, y) => ((layer(name, 'tilelayer')?.data?.[y * map.width + x]) ?? 0) & GID_MASK;
  const walkable = (x, y) => tileAt('collision', x, y) === 0;
  const spawns = new Map((layer('spawn-points', 'objectgroup')?.objects ?? [])
    .map((o) => [o.name, { x: Math.floor(o.x / map.tilewidth), y: Math.floor(o.y / map.tileheight) }]));
  const zones = new Set((layer('zones', 'objectgroup')?.objects ?? []).map((o) => o.name));

  test(`${id}: map carries the layers TiledMapRenderer hardcodes`, () => {
    for (const n of ['floor', 'walls', 'furniture-below', 'furniture-above', 'collision']) {
      assert.ok(layer(n, 'tilelayer'), `missing tilelayer "${n}"`);
    }
    assert.ok(layer('spawn-points', 'objectgroup'), 'missing objectgroup "spawn-points"');
    assert.ok(layer('zones', 'objectgroup'), 'missing objectgroup "zones"');
  });

  test(`${id}: every name the ThemeConfig references exists in spawn-points`, () => {
    const needed = [
      ...theme.primarySeatNames,
      ...theme.cafeSeatNames,
      ...theme.cafeStands.map(([n]) => n),
      'entrance',   // OfficeFloor.tsx reads this literal for blocked-agent wait tiles
    ];
    for (const n of needed) assert.ok(spawns.has(n), `spawn point "${n}" is missing from ${id}.tmj`);
    assert.equal(theme.primarySeatNames[0], 'desk-ceo', 'seat 0 is reserved for the god agent');
    assert.equal(new Set(theme.primarySeatNames).size, theme.primarySeatNames.length, 'duplicate seat name');
  });

  test(`${id}: the boardroom zone exists (the only zone the engine reads)`, () => {
    assert.ok(zones.has('boardroom'), 'OfficeFloor.tsx:348 addZoneSeats("boardroom") would silently no-op');
  });

  test(`${id}: every errand stand is walkable`, () => {
    for (const spot of theme.errandSpots) {
      assert.ok(walkable(spot.stand.x, spot.stand.y),
        `${spot.kind} errand stand (${spot.stand.x},${spot.stand.y}) is inside collision`);
    }
  });

  test(`${id}: seats carry the monitor off block at (seat.x, seat.y - 2)`, () => {
    // OfficeFloor.tsx:1407 attaches a DeskScreen only on an exact gid match at
    // that exact offset. Zero matches means no seat in the theme ever lights up.
    const lit = theme.primarySeatNames
      .map((n) => spawns.get(n))
      .filter((s) => s && tileAt('furniture-above', s.x, s.y - 2) === theme.monitor.offTopLeftGid);
    assert.ok(lit.length > 0, `no seat in ${id} has monitor.offTopLeftGid (${theme.monitor.offTopLeftGid}) painted two rows above it`);
  });

  test(`${id}: tileset arrays pair positionally and every gid resolves`, () => {
    assert.equal(theme.tilesets.length, map.tilesets.length,
      'themeLoader pairs texture[i] <-> tilesets[i]; the arrays must be the same length');
    const ranges = theme.tilesets.map((t, i) => {
      const meta = t.embedded ? map.tilesets[i] : t;
      return { first: meta.firstgid, count: meta.tilecount };
    });
    for (const name of ['floor', 'walls', 'furniture-below', 'furniture-above']) {
      const data = layer(name, 'tilelayer')?.data ?? [];
      for (let i = 0; i < data.length; i++) {
        const gid = data[i] & GID_MASK;
        if (!gid) continue;
        assert.ok(ranges.some((r) => gid >= r.first && gid < r.first + r.count),
          `${name}@${i % map.width},${Math.floor(i / map.width)} gid ${gid} falls outside every declared atlas`);
      }
    }
  });

  test(`${id}: monitor on-gids resolve and differ from the off block`, () => {
    const ranges = theme.tilesets.map((t, i) => {
      const meta = t.embedded ? map.tilesets[i] : t;
      return { first: meta.firstgid, count: meta.tilecount };
    });
    assert.equal(theme.monitor.onGids.length, 4, 'the on block is 2x2');
    for (const [gid] of theme.monitor.onGids) {
      assert.ok(ranges.some((r) => gid >= r.first && gid < r.first + r.count), `on-gid ${gid} outside every atlas`);
      assert.notEqual(gid, theme.monitor.offTopLeftGid, 'on tile must not be the off tile');
    }
  });
}
