'use strict';

/**
 * Single source of truth for the .cjs sidecars main-process code require()s at
 * runtime (matrix.ts, knowledge.ts, slack.ts) — Rollup/esbuild neither bundles
 * nor copies a require()'d .cjs file, so each one has to be copied into
 * out/main by hand. This list is imported by BOTH copy paths:
 *   - electron.vite.config.ts's writeBundle hook, which runs for `electron-vite
 *     dev` AND `electron-vite build`.
 *   - tools/copy-main-assets.cjs, the extra step `npm run build` runs for the
 *     packaged-app path.
 * Before this file existed the two paths each carried their OWN hand-written
 * copy of this list, and they drifted: adding matrix-trigger.cjs to one and
 * not the other left `npm run dev` requiring a file that was never there —
 * `loadTriggerModule()` (src/main/matrix.ts:104-114) threw before any network
 * call, which is why the Matrix /sync listener never started, never persisted
 * a sync token, and looked identical to a genuinely encrypted or unjoined
 * room. One list, two importers, means that specific drift can't recur.
 */
module.exports = [
  ['src/main/slack-trigger.cjs', 'out/main/slack-trigger.cjs'],
  ['src/main/matrix-trigger.cjs', 'out/main/matrix-trigger.cjs'],
  // Knowledge Graph core (pure-JS, no native deps) — required by knowledge.ts.
  ['src/main/kg-core.cjs', 'out/main/kg-core.cjs']
];
