'use strict';

/**
 * Regression: a wake nudge can go stale between being queued and being typed.
 *
 * The poll that decides to nudge and the drain that actually types the nudge
 * into the pty are separated in time — delivery is gated on the agent going
 * idle, which can lag the decision by a long time. If the agent drains its own
 * inbox autonomously in that gap (its own protocol has it check on every task,
 * independent of either wake mechanism), the queued nudge is now telling it
 * something false: it fires against an inbox that's been empty for a while.
 *
 * `nudgeDecision` (worker-cwd-starvation.test.cjs) only stops FUTURE polls
 * once it next observes an empty inbox — it can't retract a nudge already
 * sitting in the queue. `shouldSuppressStaleNudge` is the second check, run
 * immediately before the pty write, that closes that gap using the same
 * predicate: live inbox membership, not a timestamp or a cached decision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { shouldSuppressStaleNudge, INBOX_NUDGE_TEXT } = loadTs('src/renderer/src/hooks/inboxNudge.ts');

test('a wake nudge fired against an inbox already drained by delivery time is suppressed', () => {
  assert.equal(shouldSuppressStaleNudge(INBOX_NUDGE_TEXT, 0), true);
});

test('genuinely-unread mail still fires — the over-fire-safe default is unchanged', () => {
  assert.equal(shouldSuppressStaleNudge(INBOX_NUDGE_TEXT, 1), false);
  assert.equal(shouldSuppressStaleNudge(INBOX_NUDGE_TEXT, 5), false);
});

test('a failed live re-check fails OPEN — never suppress on missing information', () => {
  assert.equal(shouldSuppressStaleNudge(INBOX_NUDGE_TEXT, null), false);
});

test('only the wake nudge is subject to this at all — other queue items never are', () => {
  assert.equal(shouldSuppressStaleNudge('/clear', 0), false);
  assert.equal(shouldSuppressStaleNudge('a Slack-relayed message', 0), false);
  assert.equal(shouldSuppressStaleNudge('', 0), false);
});
