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
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assets = require('../tools/main-sidecar-assets.cjs');

test('every .cjs sidecar require()d at runtime by src/main is registered for copying', () => {
  const mainDir = path.join(ROOT, 'src/main');
  const requireRe = /require\(\s*['"]\.\/([a-zA-Z0-9_-]+\.cjs)['"]\s*\)/g;
  const required = new Set();
  for (const file of fs.readdirSync(mainDir)) {
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

test('electron.vite.config.ts and copy-main-assets.cjs both consume the shared list, not their own inline copy', () => {
  const configSrc = fs.readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8');
  const copyScriptSrc = fs.readFileSync(path.join(ROOT, 'tools/copy-main-assets.cjs'), 'utf8');
  assert.match(
    configSrc, /main-sidecar-assets(\.cjs)?/,
    'electron.vite.config.ts must import tools/main-sidecar-assets.cjs rather than maintaining its own inline list'
  );
  assert.match(
    copyScriptSrc, /main-sidecar-assets\.cjs/,
    'tools/copy-main-assets.cjs must require tools/main-sidecar-assets.cjs rather than maintaining its own inline list'
  );
});
