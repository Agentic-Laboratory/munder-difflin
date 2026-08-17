'use strict';

/**
 * REGRESSION: `npm run dev` never copied src/main/matrix-trigger.cjs into
 * out/main, so `loadTriggerModule()` (matrix.ts:104-114) threw on every
 * MatrixClient.start() attempt in dev mode — before whoami, before any room
 * preflight, before the sync token is ever persisted. That's why the room
 * looked "encrypted" (matrix-sync-token.json never got created) when the
 * actual room was plaintext all along: dev mode simply never got to check.
 *
 * The root design flaw: two independently hand-maintained copies of the same
 * "which .cjs sidecars need to ride along with out/main" list — one in
 * electron.vite.config.ts (covers `electron-vite dev` AND `electron-vite
 * build`), one in tools/copy-main-assets.cjs (covers only the npm run build
 * -> copy:main-assets step). The exact same gap already broke `npm run dev`
 * once for slack-trigger.cjs (#67) and was fixed in both lists by hand; when
 * Matrix was wired in later, only one of the two lists got the new entry.
 * tools/main-sidecar-assets.cjs is now the single list both consumers import,
 * so a third recurrence of "added to one list, forgot the other" is
 * structurally impossible — and this test independently re-derives the
 * requirement from the require() call sites themselves, so a FOURTH sidecar
 * that nobody remembers to register anywhere is still caught.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const assets = require('../tools/main-sidecar-assets.cjs');

test('every .cjs sidecar require()d at runtime by src/main is registered for copying', () => {
  const mainDir = path.join(ROOT, 'src/main');
  // Matches './name.cjs' AND any '../' depth (e.g. '../shared/name.cjs'), not just
  // a single './' — src/main is flat today so this never bit, but the scan
  // shouldn't silently miss a sidecar the moment a subdirectory shows up.
  const requireRe = /require\(\s*['"](?:\.\.?\/)+([a-zA-Z0-9_-]+\.cjs)['"]\s*\)/g;
  const required = new Set();
  // recursive: true so a sidecar required from a future src/main subdirectory is
  // still scanned, not silently skipped the way a plain readdirSync would.
  for (const file of fs.readdirSync(mainDir, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(mainDir, file), 'utf8');
    let m;
    while ((m = requireRe.exec(src))) required.add(m[1]);
  }
  // Sanity: if this ever finds nothing, the regex/scan broke silently and the
  // rest of this test would pass for the wrong reason.
  assert.ok(required.size > 0, 'expected at least one require(\'./*.cjs\') call site in src/main');

  const covered = new Set(assets.map(([fromRel]) => path.basename(fromRel)));
  for (const name of required) {
    assert.ok(
      covered.has(name),
      `${name} is require()d from src/main at runtime but has no entry in ` +
      'tools/main-sidecar-assets.cjs — it will be missing from out/main under ' +
      '`npm run dev`, and the require() throws before any network call, ' +
      'leaving no trace that would fail typecheck or test:focused.'
    );
  }
});

test('matrix-trigger.cjs is registered (regression for the dev-mode Matrix listener bug)', () => {
  const entry = assets.find(([fromRel]) => fromRel === 'src/main/matrix-trigger.cjs');
  assert.ok(entry, 'src/main/matrix-trigger.cjs is missing from tools/main-sidecar-assets.cjs');
  assert.equal(entry[1], 'out/main/matrix-trigger.cjs');
});

test('copy-main-assets.cjs consumes the shared list, not its own inline copy', () => {
  const copyScriptSrc = fs.readFileSync(path.join(ROOT, 'tools/copy-main-assets.cjs'), 'utf8');
  assert.match(
    copyScriptSrc, /main-sidecar-assets\.cjs/,
    'tools/copy-main-assets.cjs must require tools/main-sidecar-assets.cjs rather than maintaining its own inline list'
  );
});

// electron.vite.config.ts's copyMainSidecars plugin previously had this covered
// by `assert.match(configSrc, /main-sidecar-assets(\.cjs)?/)` — a bare source-text
// check. electron.vite.config.ts:30 has a COMMENT that also contains the string
// "main-sidecar-assets", so deleting the real `require('./tools/main-sidecar-
// assets.cjs')` and hardcoding the array inline again — recreating the exact
// drift bug this file exists to prevent — left that assertion passing, satisfied
// by prose instead of by the actual import. A regression test that a comment can
// satisfy is worse than no test: it reads as coverage.
//
// This replaces it with a REFERENCE-IDENTITY check: load the real config (via
// load-ts.cjs, the same harness every other test in this repo uses for
// TypeScript-under-node:test) and the shared list SEPARATELY through that same
// harness — its module cache is keyed by resolved absolute path, so the second
// load returns the IDENTICAL array object the config's own internal require()
// produced, not a fresh copy. Swap that shared array's contents for a single
// fixture entry pointing at real files outside the repo (os.tmpdir(), so the
// live out/main/ the dev app is running off is never touched) and invoke the
// plugin's real writeBundle(). Only a plugin that is actually iterating THIS
// array at call time — not a snapshot, not a hardcoded literal — can produce the
// fixture copy. No text in the file, comment or otherwise, can make that happen.
test('copyMainSidecars actually iterates the imported list (reference identity, not text presence)', () => {
  const configMod = loadTs('electron.vite.config.ts');
  const plugin = configMod.default.main.plugins.find((p) => p.name === 'copy-main-cjs-sidecars');
  assert.ok(plugin && typeof plugin.writeBundle === 'function', 'copyMainSidecars plugin not found on the main config');

  // Loaded through the SAME load-ts.cjs cache the config's own internal
  // require('./tools/main-sidecar-assets.cjs') just populated — this is the
  // identical array reference the plugin closed over, not a lookalike.
  const liveAssets = loadTs('tools/main-sidecar-assets.cjs');

  const fakeSrc = path.join(os.tmpdir(), `sidecar-identity-fixture-${process.pid}.cjs`);
  const fakeDest = path.join(os.tmpdir(), `sidecar-identity-copy-${process.pid}.cjs`);
  fs.writeFileSync(fakeSrc, 'module.exports = 1;\n');
  const original = liveAssets.splice(0, liveAssets.length, [fakeSrc, fakeDest]);
  try {
    plugin.writeBundle();
    assert.ok(
      fs.existsSync(fakeDest),
      'copyMainSidecars did not copy the fixture entry after the shared assets array was mutated in place — ' +
      'it must be closing over a stale copy or a hardcoded list rather than the live tools/main-sidecar-assets.cjs import'
    );
  } finally {
    liveAssets.splice(0, liveAssets.length, ...original);
    fs.rmSync(fakeSrc, { force: true });
    fs.rmSync(fakeDest, { force: true });
  }
});
