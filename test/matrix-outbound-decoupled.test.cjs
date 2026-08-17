'use strict';

/**
 * startMatrixClient (src/main/index.ts) used to call startMatrixDoneObserver()
 * only AFTER client.start() reported ok:true, with an early `return res` on
 * ok:false landing before it. So any inbound preflight failure (an encrypted
 * room, the bot removed from a room, a homeserver hiccup on restart) silently
 * killed the OUTBOUND done-summary reply path too, even though sendMatrixMessage
 * is a direct fetch that needs nothing from /sync — pollMatrixDoneTasks fetches
 * its own credentials independently and no-ops safely without them.
 *
 * index.ts imports 'electron' at module scope (app.requestSingleInstanceLock(),
 * dozens of ipcMain.handle() registrations run at import time), so it cannot be
 * loaded under node:test the way matrix.ts is loaded elsewhere in this suite.
 * Unlike checkMatrixIdentity/computeRoomIdsRewrite (real branching decision
 * logic, extracted into matrix.ts and tested there), this fix is a pure
 * statement-ordering fact with a single call site and no interesting input/
 * output space — extracting it into a generically-typed sequencing helper for
 * one caller would be more machinery than the fix itself. So this pins the
 * ordering directly against the real source text instead: a regression here
 * means startMatrixDoneObserver() moved back to after the preflight, or a
 * second copy of it reappeared after client.start() — either way, the same
 * defect this fix closes.
 *
 * A second, narrower defect showed up once the observer started on every
 * startMatrixClient() call instead of only on success: reconcileMatrixClient()
 * re-runs startMatrixClient() on every Matrix config save (and every failed
 * retry), and startMatrixClient() used to tear the instance down via the FULL
 * stopMatrixClient() — which also stops the done-observer and nulls its
 * baseline — right before immediately restarting the observer. That reseeded
 * matrixDoneBaseline on every single reconcile/retry instead of once per real
 * session, briefly reopening a window where a card finishing 'done' at that
 * instant gets swept into the fresh baseline and never gets a reply. The fix
 * is stopMatrixSyncClient() (leaves the observer's timer alone) in place of
 * stopMatrixClient() at that one call site, so startMatrixDoneObserver()'s own
 * `if (matrixDoneTimer) return` guard actually holds across repeated restarts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

function startMatrixClientBody() {
  const start = SOURCE.indexOf('async function startMatrixClient(');
  assert.ok(start >= 0, 'startMatrixClient must still exist in src/main/index.ts');
  // Bound tightly to this function's own closing brace — NOT to the next
  // function declaration — so a helper inserted between startMatrixClient and
  // stopMatrixClient (e.g. stopMatrixSyncClient, plus its doc comment) can't
  // get swept into "body" and inflate the call-site counts below with its own
  // prose mentioning these same function names.
  const closeMarker = '\n  return res;\n}\n';
  const closeAt = SOURCE.indexOf(closeMarker, start);
  assert.ok(closeAt > start, "startMatrixClient must still end with 'return res;'");
  return SOURCE.slice(start, closeAt + closeMarker.length);
}

test('startMatrixDoneObserver() runs before the inbound preflight (client.start()), not after it', () => {
  const body = startMatrixClientBody();

  const observerCalls = [...body.matchAll(/startMatrixDoneObserver\(\)/g)];
  assert.equal(observerCalls.length, 1,
    'expected exactly one call site — a second one reappearing after client.start() would silently ' +
    'reintroduce the coupling this fix removes');

  const observerAt = observerCalls[0].index;
  const preflightAt = body.indexOf('await client.start()');
  assert.ok(preflightAt >= 0, 'client.start() must still be the inbound preflight call');

  assert.ok(observerAt < preflightAt,
    'the done-observer must start before the inbound preflight runs, so an ok:false result ' +
    'cannot prevent it from ever starting');
});

test('the early return on a failed preflight sits after the done-observer start, not before it', () => {
  const body = startMatrixClientBody();

  const observerAt = body.indexOf('startMatrixDoneObserver()');
  const earlyReturnAt = body.indexOf('if (!res.ok)');
  assert.ok(observerAt >= 0 && earlyReturnAt >= 0);

  assert.ok(observerAt < earlyReturnAt,
    'the observer must already be running by the time the preflight can early-return — ' +
    'this is the exact ordering that let an inbound failure silently kill outbound replies');
});

test('startMatrixClient() replaces a running instance via stopMatrixSyncClient(), not the full stopMatrixClient()', () => {
  const body = startMatrixClientBody();

  const fullStopCalls = [...body.matchAll(/(?<!Sync)stopMatrixClient\(\)/g)];
  assert.equal(fullStopCalls.length, 1,
    'expected exactly one full stopMatrixClient() call inside startMatrixClient — the ' +
    '"matrix disabled" early return. A second one (e.g. before the observer restart) would ' +
    'reseed matrixDoneBaseline on every reconcile/retry instead of once per real session');

  const syncStopAt = body.indexOf('stopMatrixSyncClient()');
  assert.ok(syncStopAt >= 0,
    'startMatrixClient() must replace a running instance via stopMatrixSyncClient(), which ' +
    'leaves the done-observer (and its baseline) alone — the full stopMatrixClient() would ' +
    "undercut startMatrixDoneObserver()'s own idempotent guard on every restart");

  const observerAt = body.indexOf('startMatrixDoneObserver()');
  assert.ok(syncStopAt < observerAt,
    'stopMatrixSyncClient() must run immediately before the observer start, replacing the ' +
    'old instance without touching the observer timer/baseline');
});

test('stopMatrixSyncClient() and stopMatrixClient() are both still defined, with stopMatrixClient() composed from the narrower one', () => {
  assert.match(SOURCE, /function stopMatrixSyncClient\(\): void \{/,
    'stopMatrixSyncClient() must exist — the narrower stop used mid-restart');
  const stopClientDecl = SOURCE.indexOf('function stopMatrixClient(): void {');
  assert.ok(stopClientDecl >= 0, 'stopMatrixClient() must still exist for genuine stops');
  const stopClientBody = SOURCE.slice(stopClientDecl, SOURCE.indexOf('\n}', stopClientDecl));
  assert.match(stopClientBody, /stopMatrixSyncClient\(\)/,
    'stopMatrixClient() should reuse stopMatrixSyncClient() rather than duplicating the stop logic');
  assert.match(stopClientBody, /stopMatrixDoneObserver\(\)/,
    'stopMatrixClient() must still stop the done-observer too — it is the genuine full-stop path');
});
