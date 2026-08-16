'use strict';

/**
 * Regression: a spawned worker was silently starved of its objective.
 *
 * The worker booted, registered a session, was correctly named and read
 * breaker-green on the floor — and then did nothing at all until the 20-minute
 * idle reaper took it. It never wrote a transcript, because it was never given a
 * prompt: the single inbox-wake nudge that carries "you have mail" was enqueued
 * ~3.5s after spawn, written to the PTY once, and then permanently suppressed.
 *
 * Two faults, both exercised here:
 *   1. One attempt, no receipt. Nothing re-checked whether the mail was ever
 *      read, so a write that landed before the CLI was reading stdin was the
 *      worker's only chance. Delivery now retries on a bounded backoff for as
 *      long as the same mail is still undrained.
 *   2. "Newest" was a string sort. The rescue message sent to one starved worker
 *      carried the hand-authored id "2026-08-16-nudge-matrix-trigger-logic",
 *      which sorts BELOW the generated "2026-08-16T18-38-49-200Z-28f64a"
 *      ('-' < 'T'), so `ids.sort().slice(-1)` still returned the OLD id and the
 *      rescue produced no nudge either. Freshness is now set membership.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  nudgeDecision, INBOX_NUDGE_TEXT, NUDGE_RETRY_MS, MAX_NUDGE_ATTEMPTS
} = loadTs('src/renderer/src/hooks/inboxNudge.ts');

const inbox = (...ids) => ids.map((id) => ({ id }));

test('mail that has never been mentioned is nudged immediately', () => {
  const d = nudgeDecision(undefined, inbox('m1'), 1000);
  assert.equal(d.nudge, true);
  assert.deepEqual(d.state.seen, ['m1']);
  assert.equal(d.state.attempts, 1);
});

test('the same undrained mail is not re-nudged on every 4s poll', () => {
  const first = nudgeDecision(undefined, inbox('m1'), 0);
  const soon = nudgeDecision(first.state, inbox('m1'), 4000);
  assert.equal(soon.nudge, false, 'a poll inside the backoff gap must stay quiet');
  assert.equal(soon.state.attempts, 1);
});

test('a lost first attempt is retried once the gap passes — the starvation fix', () => {
  // The worker never read it: the message is still sitting in its inbox.
  const first = nudgeDecision(undefined, inbox('m1'), 0);
  const retry = nudgeDecision(first.state, inbox('m1'), NUDGE_RETRY_MS[0]);
  assert.equal(retry.nudge, true, 'undrained mail must get another attempt');
  assert.equal(retry.state.attempts, 2);
});

test('retries are bounded — an agent sitting on filed-but-unmoved mail is not looped', () => {
  let state;
  let at = 0;
  let nudges = 0;
  // Walk far past the whole schedule at the real 4s poll cadence.
  for (; at <= 600_000; at += 4000) {
    const d = nudgeDecision(state, inbox('m1'), at);
    state = d.state;
    if (d.nudge) nudges += 1;
  }
  assert.equal(nudges, MAX_NUDGE_ATTEMPTS);
  assert.equal(MAX_NUDGE_ATTEMPTS, 4);
});

test('a follow-up id that string-sorts BELOW the first still wakes the agent', () => {
  // The exact ids from the incident: the rescue message god sent to a starved
  // worker, which the old `ids.sort().slice(-1)` could not see.
  const original = '2026-08-16T18-38-49-200Z-28f64a';
  const rescue = '2026-08-16-nudge-matrix-trigger-logic';
  assert.equal([original, rescue].sort().slice(-1)[0], original, 'the sort really is the wrong tool');

  const first = nudgeDecision(undefined, inbox(original), 0);
  assert.equal(first.nudge, true);
  // Rescue arrives while the first is still undrained, INSIDE the backoff gap so
  // only its own freshness can explain a nudge.
  const second = nudgeDecision(first.state, inbox(original, rescue), 1000);
  assert.equal(second.nudge, true, 'new mail is new mail whatever its id sorts like');
  assert.equal(second.state.attempts, 1, 'fresh mail restarts the retry budget');
});

test('an empty inbox clears the slate, and later mail is fresh again', () => {
  const first = nudgeDecision(undefined, inbox('m1'), 0);
  const drained = nudgeDecision(first.state, [], 5000);
  assert.equal(drained.nudge, false);
  assert.equal(drained.state, undefined, 'nothing to remember about an empty inbox');
  // Even the SAME id, re-sent later, must wake the agent again.
  const again = nudgeDecision(drained.state, inbox('m1'), 6000);
  assert.equal(again.nudge, true);
});

test('draining one of two messages does not re-nudge for the survivor', () => {
  const first = nudgeDecision(undefined, inbox('m1', 'm2'), 0);
  assert.equal(first.nudge, true);
  const partial = nudgeDecision(first.state, inbox('m2'), 1000);
  assert.equal(partial.nudge, false, 'a shrinking inbox is progress, not new mail');
  assert.deepEqual(partial.state.seen, ['m2']);
});

test('a nudge still queued suppresses both the re-enqueue and the retry clock', () => {
  const first = nudgeDecision(undefined, inbox('m1'), 0);
  const held = nudgeDecision(first.state, inbox('m1'), NUDGE_RETRY_MS[0], true);
  assert.equal(held.nudge, false, 'the agent is mid-turn, not starved');
  assert.equal(held.state.attempts, 1, 'a pending nudge must not burn a retry');

  // A queued nudge only reaches the terminal once the agent goes idle, which can
  // take longer than the whole backoff gap. The gap must be measured from THAT
  // moment, not from the enqueue — otherwise the retry fires seconds after the
  // agent finally reads its mail and lands on an inbox it just emptied.
  const delivered = NUDGE_RETRY_MS[0] + 4000;
  const justSent = nudgeDecision(held.state, inbox('m1'), delivered);
  assert.equal(justSent.nudge, false, 'no retry on the poll right after delivery');

  // Still undrained a full gap after delivery → now it is genuinely stuck.
  const after = nudgeDecision(justSent.state, inbox('m1'), delivered + NUDGE_RETRY_MS[0]);
  assert.equal(after.nudge, true);
  assert.equal(after.state.attempts, 2);
});

test('the wake prompt is a single shared constant', () => {
  assert.match(INBOX_NUDGE_TEXT, /new hive inbox message/);
});
