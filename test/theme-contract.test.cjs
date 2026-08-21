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

  // Flood fill from the entrance over the same 4-neighbourhood as
  // scene/office/pathfinding.ts, with seats/stands force-walkable exactly as the
  // runtime forces them. Walkable is not enough on its own: a tile can be clear
  // and still be sealed off behind furniture.
  const reachable = (() => {
    const start = spawns.get('entrance');
    const open = new Set();
    const force = (t) => t && open.add(`${t.x},${t.y}`);
    for (const n of [...theme.primarySeatNames, ...theme.cafeSeatNames]) force(spawns.get(n));
    for (const [n] of theme.cafeStands) force(spawns.get(n));
    const passable = (x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height
      && (walkable(x, y) || open.has(`${x},${y}`));
    const seen = new Set([`${start.x},${start.y}`]);
    const q = [start];
    while (q.length) {
      const { x, y } = q.shift();
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (!seen.has(`${nx},${ny}`) && passable(nx, ny)) { seen.add(`${nx},${ny}`); q.push({ x: nx, y: ny }); }
      }
    }
    return (x, y) => seen.has(`${x},${y}`);
  })();

  test(`${id}: the board-choreography stands are walkable AND reachable`, () => {
    // The bug this exists for: with no path, Character.walkToAndThen (Character.ts:189)
    // drops the arrival callback, so the actor never walks, the boards never
    // update, and the move sits in busyActors until the 30 s watchdog fires.
    for (const [role, t] of Object.entries(theme.anchors.boardStands)) {
      assert.ok(walkable(t.x, t.y), `${role} stand (${t.x},${t.y}) is inside collision`);
      assert.ok(reachable(t.x, t.y), `${role} stand (${t.x},${t.y}) is walled off from the entrance`);
    }
  });

  test(`${id}: every wall prop hangs on a wall`, () => {
    // These are Graphics with no map art behind them, so a wrong anchor doesn't
    // fail — it just floats a cork board over open floor with agents walking
    // through it. A single-row perimeter (brooklyn99) puts the prop on the row
    // under the wall, so either tile counts.
    const onWall = (t) => tileAt('walls', t.x, t.y) !== 0
      || (t.y > 0 && tileAt('walls', t.x, t.y - 1) !== 0);
    for (const name of ['calendar', 'boards', 'clock', 'askMe']) {
      const t = theme.anchors[name];
      assert.ok(t, `anchors.${name} is missing`);
      assert.ok(onWall(t), `anchors.${name} (${t.x},${t.y}) is over open floor, not a wall`);
    }
  });

  test(`${id}: the clock anchor carries art and a matching hit area`, () => {
    const c = theme.anchors.clock;
    assert.notEqual(tileAt('furniture-above', c.x, c.y), 0,
      `no art at anchors.clock (${c.x},${c.y}) — the closing-time prop would be an invisible click target`);
    const box = theme.anchors.clockSize ?? { w: 16, h: 32 };
    // A 2-tile hit area needs a second tile of clock under the first, or the
    // lower half is dead space over whatever is below it.
    if (box.h > 16) {
      assert.notEqual(tileAt('furniture-above', c.x, c.y + 1), 0,
        `clockSize is ${box.w}x${box.h} but (${c.x},${c.y + 1}) has no art`);
    }
  });

  test(`${id}: the coffee economy has art under it and reachable stands`, () => {
    // The tray, sink and steam are Graphics drawn OVER map art. With nothing
    // beneath them, the mug rack and basin float on bare floor.
    for (const k of ['trayTile', 'machineTile', 'sinkTile']) {
      const t = theme.coffee[k];
      assert.ok(t, `coffee.${k} is missing`);
      assert.ok(tileAt('furniture-below', t.x, t.y) !== 0 || tileAt('furniture-above', t.x, t.y) !== 0,
        `coffee.${k} (${t.x},${t.y}) has no art beneath it`);
    }
    for (const k of ['trayStand', 'machineStand', 'sinkStand']) {
      const t = theme.coffee[k];
      assert.ok(walkable(t.x, t.y), `coffee.${k} (${t.x},${t.y}) is inside collision`);
      assert.ok(reachable(t.x, t.y), `coffee.${k} (${t.x},${t.y}) is walled off from the entrance`);
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

// ─── ClickableProp: a hit area is only as good as the art under it ───────────
// Parsed from the source, so renaming a tab breaks the test instead of silently
// shipping a prop that opens nothing.
const CC_TABS = (() => {
  const src = fs.readFileSync(path.join(R, 'components/CommandCenterPanel.tsx'), 'utf8');
  const decl = /type CCTab =([\s\S]*?);/.exec(src);
  assert.ok(decl, 'CCTab union not found in CommandCenterPanel.tsx');
  return new Set([...decl[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]));
})();

for (const id of themeIds) {
  const theme = THEMES[id];
  const map = JSON.parse(theme.mapRaw);
  const layer = (name) => map.layers.find((l) => l.name === name && l.type === 'tilelayer');
  const tileAt = (name, x, y) => ((layer(name)?.data?.[y * map.width + x]) ?? 0) & GID_MASK;
  const walkable = (x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height
    && tileAt('collision', x, y) === 0;

  test(`${id}: every clickable prop sits on real art and opens a real tab`, () => {
    for (const prop of theme.props ?? []) {
      const { x, y } = prop.tile;
      const w = prop.w ?? 1, h = prop.h ?? 1;
      assert.ok(CC_TABS.has(prop.tab), `prop "${prop.label}" opens tab "${prop.tab}", which is not a CCTab`);
      assert.ok(prop.label, 'a prop with no label gives the viewer nothing on hover');
      // Art anywhere in the footprint: the code draws none of its own, so with a
      // bare anchor this is an invisible hit area over empty floor.
      let art = 0;
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
          if (tileAt('furniture-below', x + dx, y + dy) || tileAt('furniture-above', x + dx, y + dy)) art++;
        }
      }
      assert.ok(art > 0, `prop "${prop.label}" at (${x},${y}) ${w}x${h} has no map art in its footprint`);
      // No walkable tile inside the footprint. An agent standing in one would be
      // under a pointer-catching Graphics, so the click that should SELECT them
      // would open a Command Center tab instead. The office's conference table
      // sits inside the boardroom zone, whose overflow seats are derived from
      // whatever is walkable there (OfficeFloor.tsx addZoneSeats), so this is a
      // live hazard, not a theoretical one.
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
          assert.ok(!walkable(x + dx, y + dy),
            `prop "${prop.label}" covers walkable tile (${x + dx},${y + dy}) — it would swallow clicks on an agent standing there`);
        }
      }
      // And it has to be approachable, or it is a click target in a sealed box.
      const ring = [];
      for (let dx = -1; dx <= w; dx++) ring.push([x + dx, y - 1], [x + dx, y + h]);
      for (let dy = 0; dy < h; dy++) ring.push([x - 1, y + dy], [x + w, y + dy]);
      assert.ok(ring.some(([rx, ry]) => walkable(rx, ry)),
        `prop "${prop.label}" at (${x},${y}) is walled in on every side`);
    }
  });
}

// ─── the board walk has to fit the watchdog ──────────────────────────────────
// Placing the boards is a geometry decision with a TIMING consequence: the actor
// walks there and (for a `take`) back, and if that outlasts the watchdog the
// boards hard-sync mid-walk — the same broken-looking result as an unreachable
// stand, from a different cause. Both numbers are read from source so a change
// to either shows up here.
const TIMEOUT_S = Number(/BOARD_MOVE_TIMEOUT_S = (\d+)/.exec(
  fs.readFileSync(path.join(R, 'scene/office/OfficeFloor.tsx'), 'utf8'))?.[1]);
const SPEED_PX = Number(/const SPEED = (\d+)/.exec(
  fs.readFileSync(path.join(R, 'scene/office/Character.ts'), 'utf8'))?.[1]);

test('the watchdog timeout and the walk speed are both readable from source', () => {
  assert.ok(TIMEOUT_S > 0, 'BOARD_MOVE_TIMEOUT_S not found in OfficeFloor.tsx');
  assert.ok(SPEED_PX > 0, 'SPEED not found in Character.ts');
});

for (const id of themeIds) {
  const theme = THEMES[id];
  const map = JSON.parse(theme.mapRaw);
  const layer = (name) => map.layers.find((l) => l.name === name && l.type === 'tilelayer');
  const tileAt = (name, x, y) => ((layer(name)?.data?.[y * map.width + x]) ?? 0) & GID_MASK;
  const spawns = new Map((map.layers.find((l) => l.name === 'spawn-points')?.objects ?? [])
    .map((o) => [o.name, { x: Math.floor(o.x / map.tilewidth), y: Math.floor(o.y / map.tileheight) }]));
  const forced = new Set([...spawns.values()].map((t) => `${t.x},${t.y}`));
  const passable = (x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height
    && (tileAt('collision', x, y) === 0 || forced.has(`${x},${y}`));
  const steps = (from, to) => {
    const seen = new Set([`${from.x},${from.y}`]);
    let q = [[from.x, from.y, 0]];
    while (q.length) {
      const [x, y, d] = q.shift();
      if (x === to.x && y === to.y) return d;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (passable(nx, ny) && !seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); q.push([nx, ny, d + 1]); }
      }
    }
    return Infinity;
  };

  test(`${id}: the longest board round trip fits the watchdog with margin`, () => {
    const tilesPerSec = SPEED_PX / map.tilewidth;
    const ACTING_BEAT = 0.9;   // the setTimeout in startMove
    let worst = { secs: 0 };
    for (const [role, stand] of Object.entries(theme.anchors.boardStands)) {
      for (const name of theme.primarySeatNames) {
        const seat = spawns.get(name);
        const d = steps(seat, stand);
        assert.notEqual(d, Infinity, `${name} cannot reach the ${role} stand at all`);
        // `take` is the round trip: seat -> stand, beat, stand -> desk.
        const secs = (role === 'take' ? 2 * d : d) / tilesPerSec + ACTING_BEAT;
        if (secs > worst.secs) worst = { secs, role, name, d };
      }
    }
    // 20% headroom: the BFS distance is a lower bound (no repaths, no pauses).
    assert.ok(worst.secs < TIMEOUT_S * 0.8,
      `worst board move (${worst.role} from ${worst.name}, ${worst.d} tiles) takes ~${worst.secs.toFixed(1)}s `
      + `against a ${TIMEOUT_S}s watchdog — the boards would hard-sync mid-walk`);
  });
}

// ─── source guards: the props must stay theme-driven ─────────────────────────
// Every assertion above reads ThemeConfig, so it is blind to a coordinate typed
// straight into the scene. These two catch that: they are the reason the office's
// (26,17) steam, (14,10) ASK ME board and (8,11) board stands survived a whole
// theme extraction unnoticed.
const OFFICE_FLOOR = fs.readFileSync(path.join(R, 'scene/office/OfficeFloor.tsx'), 'utf8');

test('OfficeFloor positions no prop at a hardcoded tile coordinate', () => {
  const hits = OFFICE_FLOOR.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /position\.set\(\s*\d+\s*\*/.test(line));
  assert.deepEqual(hits, [], `hardcoded tile position(s): ${hits.map(([n, l]) => `L${n}: ${l.trim()}`).join(' | ')}`);
});

test('the clock hit area is derived from the theme, not a literal', () => {
  // The assignment spans lines, so read the whole expression: a line-scoped
  // check would only ever see `clockG.hitArea = {` and pass no matter what the
  // extent below it said.
  const at = OFFICE_FLOOR.indexOf('clockG.hitArea');
  assert.notEqual(at, -1, 'clockG.hitArea vanished — update this guard');
  const expr = OFFICE_FLOOR.slice(at, OFFICE_FLOOR.indexOf('};', at) + 2);
  assert.match(expr, /clockBox/, `the clock hit area must come from anchors.clockSize: ${expr}`);
  assert.doesNotMatch(expr, /<=\s*\d/,
    `the clock hit area carries a literal extent, so it cannot match a theme whose clock is a different size: ${expr}`);
});

// ─── the orchestrator's identity ─────────────────────────────────────────────
//
// Every other agent carries its character in roster.json, but god's PTY never
// survives a restart: useHive drops its roster entry and rebuilds the agent from
// scratch on each launch. So god's name and sprite come from code alone, and a
// literal there silently un-themes the most visible agent on the floor on every
// relaunch — the exact failure this guards.
const CAST = loadModule(path.join(R, 'scene/office/cast.ts'));
const USE_HIVE = fs.readFileSync(path.join(R, 'hooks/useHive.ts'), 'utf8');
const BOOTING = fs.readFileSync(path.join(R, 'components/MichaelBooting.tsx'), 'utf8');

test('every theme with its own roster names its own orchestrator', () => {
  const registry = loadRegistry();
  for (const [id, theme] of Object.entries(registry.THEMES)) {
    const god = CAST.godForTheme(id);
    assert.ok(god, `${id}: godForTheme returned nothing`);
    // god must be drawable by the theme that will render it: either from that
    // theme's own roster, or from the office cast it falls back to.
    const own = theme.cast.byName[god.name];
    const fallback = CAST.OFFICE_CAST_BY_NAME[god.name];
    assert.ok(own || fallback,
      `${id}: orchestrator '${god.name}' is in neither this theme's cast nor the office's`);
    assert.equal(typeof god.displayName, 'string');
    assert.ok(god.displayName.length > 0, `${id}: orchestrator has no display name`);
  }
});

test('the wizarding school is run by its headmaster, the office by its boss', () => {
  assert.equal(CAST.godForTheme('wizardschool').name, 'sable');
  assert.equal(CAST.godForTheme('office').name, 'michael');
  // An unregistered/absent id resolves to the office, matching getTheme.
  assert.equal(CAST.godForTheme('friends').name, 'michael');
  assert.equal(CAST.godForTheme(undefined).name, 'michael');
  // The id is internal; the DISPLAY name is the thing on the card, the terminal
  // tab and the /remote-control session — so pin that too. Asserting only the id
  // would stay green through a rename of every name the user actually sees.
  assert.equal(CAST.godForTheme('wizardschool').displayName, 'Dumbledore');
  assert.equal(CAST.godForTheme('office').displayName, 'Michael');
});

test("god's identity is derived from the theme, not a literal", () => {
  // Scope to the spawn block so an unrelated 'Michael' elsewhere can't mask a
  // regression here (nor cause a false failure).
  const at = USE_HIVE.indexOf('const god: Agent = {');
  assert.notEqual(at, -1, 'the god Agent literal moved — update this guard');
  const expr = USE_HIVE.slice(at, USE_HIVE.indexOf('};', at) + 2);
  assert.match(expr, /name:\s*godCast\.displayName/, 'god must take its name from the theme');
  assert.match(expr, /character:\s*godCast\.name/, 'god must take its character from the theme');
  assert.doesNotMatch(expr, /'[Mm]ichael'/,
    `god's entry carries a hardcoded cast name, so a themed floor reverts to Michael on relaunch: ${expr}`);
});

test('the boot loader names the orchestrator from the theme', () => {
  // It is the first thing drawn after a hive opens — a literal here gives the
  // theme away before the floor has even rendered.
  assert.match(BOOTING, /godForTheme/, 'the loader must resolve the orchestrator from the theme');
  assert.doesNotMatch(BOOTING.replace(/\/\*[\s\S]*?\*\//g, ''), /Michael is settling/,
    'the boot loader hardcodes Michael in visible copy');
});
