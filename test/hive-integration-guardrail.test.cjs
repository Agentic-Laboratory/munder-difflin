'use strict';

/**
 * An agent doing branch integration in the SAME worktree the dev server watches
 * takes the running app down with it. On 2026-08-17 a worker was authorised to
 * "merge all branches back to main"; it ran the merge in the live checkout, the
 * merge conflicted, and the conflict markers it left in
 * src/renderer/src/hooks/useHive.ts:26 broke the running app's HMR with an
 * esbuild `Unexpected "<<"` for ~100 seconds until the merge was committed.
 *
 * The guardrail against that has to reach WORKERS, not just god — the agent that
 * did it was a worker. So it lives on the shared prompt spine, and these tests
 * pin it there for every agent kind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

// Built rather than written literally so this file never itself contains a
// sequence that a git merge or a bundler would mistake for a real marker.
const MARKER = '<'.repeat(7);

function promptFor(t, meta) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-guardrail-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const root = path.join(home, 'hive');
  const dir = path.join(root, 'agents', meta.id);
  return hive.injectedPrompt(meta, dir, root, false, false);
}

const WORKER = { id: 'ryan-test', name: 'Ryan' };
const GOD = { id: 'god', name: 'Michael', isGod: true };
const ASSISTANT = { id: 'prep', name: 'Prep', isAssistant: true };

test('a worker is told not to run git checkout/merge/rebase against a live dev server', (t) => {
  const p = promptFor(t, WORKER);

  // The prohibition itself, and all three verbs it has to cover — a rule that
  // named only `merge` would still permit the branch switch that silently served
  // main's code to the running window.
  assert.match(p, /NEVER run git checkout, git merge, or git rebase/,
    'the worker prompt must forbid all three git writes, not just merge');
  assert.match(p, /dev server running against it/);

  // The concrete mechanism, so the agent can recognise the failure it caused.
  assert.ok(p.includes(MARKER),
    'the prompt must show the actual conflict-marker sequence the agent would leave behind');
  assert.match(p, /breaks the RUNNING app mid-session/);
});

test('the prompt gives the worktree escape hatch, not just a prohibition', (t) => {
  const p = promptFor(t, WORKER);

  // A bare "do not" leaves an authorised integration task with no way to run, so
  // the agent improvises — which is how this happened. Name the alternative.
  assert.match(p, /git worktree add/,
    'a forbidden action still needs a sanctioned path, or the agent invents one');
  assert.match(p, /git worktree remove/, 'and it has to clean the worktree up');
  assert.match(p, /fast-forward the real branch/);
});

test('the bare-push prohibition names the parent-repo hazard', (t) => {
  const p = promptFor(t, WORKER);

  // In this clone `origin` is the upstream PARENT; a bare push would have fired
  // 34 commits into someone else's repo.
  assert.match(p, /NEVER run a bare `git push`/);
  assert.match(p, /origin` is an upstream PARENT repo/,
    'the reason has to be in the prompt — "always name the remote" alone reads as style advice');
});

test('god and the prep assistant get the same guardrail as workers', (t) => {
  const worker = promptFor(t, WORKER);
  const god = promptFor(t, GOD);
  const assistant = promptFor(t, ASSISTANT);

  for (const [label, p] of [['god', god], ['assistant', assistant]]) {
    assert.match(p, /NEVER run git checkout, git merge, or git rebase/,
      `${label} must carry the guardrail too — god owns branch integration by its own prompt`);
    assert.ok(p.includes(MARKER), `${label} must carry the marker mechanism`);
  }

  // It belongs to the shared spine, so the text is identical across kinds rather
  // than three copies that can drift apart.
  const clause = (s) => s.slice(s.indexOf('INTEGRATION / GIT SAFETY'), s.indexOf('INTEGRATION / GIT SAFETY') + 400);
  assert.equal(clause(god), clause(worker), 'god and worker must share one clause, not two copies');
  assert.equal(clause(assistant), clause(worker), 'assistant too');
});

test('the guardrail is cache-stable — byte-identical across spawns', (t) => {
  // injectedPrompt is a cached system-prompt prefix; anything volatile in it
  // re-primes the whole prompt every turn. The clause must interpolate nothing.
  const a = promptFor(t, WORKER);
  const b = promptFor(t, WORKER);

  const start = 'INTEGRATION / GIT SAFETY';
  assert.notEqual(a.indexOf(start), -1, 'the clause must be present at all — otherwise the slices below\n    compare two empty strings and this test passes on a prompt with no guardrail');
  const clauseA = a.slice(a.indexOf(start)).split('\n')[0];
  const clauseB = b.slice(b.indexOf(start)).split('\n')[0];

  assert.equal(clauseA, clauseB, 'two spawns must yield the same bytes');
  assert.ok(!/\/(private\/)?(tmp|var)\//.test(clauseA),
    'no per-spawn tmpdir path may leak into the cached prefix');
  assert.ok(!/md-guardrail-/.test(clauseA), 'no per-spawn fixture name either');
});
