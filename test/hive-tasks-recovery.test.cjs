'use strict';

/**
 * D16 regression: registering an agent runs ensureHive(), which used to
 * default tasks.json (and registry.json/board.md/log.jsonl) to an empty
 * structure whenever the file was missing from disk — with no way to tell
 * "this hive has never existed" from "this hive has real history and the
 * file just vanished." In production, a root-level move of tasks.json got
 * swept into an unrelated routing commit; the very next agent registration
 * then saw a missing tasks.json and silently rewrote it as `{tasks:[]}`,
 * discarding 27 real cards (including human answers) with no error anywhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-tasks-recovery-'));
}

function tasksPathOf(home) {
  return path.join(home, 'hive', 'tasks.json');
}

function readTasks(home) {
  return JSON.parse(fs.readFileSync(tasksPathOf(home), 'utf8'));
}

function gitIn(home, args) {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args], {
    cwd: path.join(home, 'hive'),
    encoding: 'utf8'
  });
}

function fakeTask(id) {
  return { id, title: `task ${id}`, status: 'todo', dependsOn: [], priority: 1, createdAt: new Date(0).toISOString() };
}

test('registering a new agent never reduces the task board\'s card count', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  // Bootstrap the hive and seed a real task ledger, committed the normal way.
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  hive.writeTasks([fakeTask('t1'), fakeTask('t2'), fakeTask('t3')]);
  assert.equal(readTasks(home).tasks.length, 3);

  // Reproduce the production sequence: something OUTSIDE hive.ts's own code
  // removes tasks.json from disk and that removal gets committed (mirroring
  // the stray root-file move that rode in on an unrelated "routed message(s)"
  // commit) BEFORE the next registration runs.
  fs.rmSync(tasksPathOf(home));
  gitIn(home, ['add', '-A']);
  gitIn(home, ['commit', '-q', '-m', 'simulated external wipe of tasks.json']);
  assert.equal(fs.existsSync(tasksPathOf(home)), false, 'precondition: tasks.json is really gone before registration runs');

  // The regression: a later agent registration (ensureAgent -> ensureHive)
  // must not silently reinitialize the missing ledger to empty.
  await hive.ensureAgent({ id: 'a2', name: 'B', provider: 'claude', cwd: home });

  const recovered = readTasks(home);
  assert.equal(recovered.tasks.length, 3, 'registration must recover the prior card count, not truncate it');
  assert.deepEqual(recovered.tasks.map((t) => t.id), ['t1', 't2', 't3']);

  const log = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8');
  assert.match(log, /"kind":"recovered-missing-file","path":"tasks\.json"/,
    'the recovery must be visible in the log, not silent');
});

test('an uncommitted disk-level wipe (no external commit yet) is also recovered', async (t) => {
  // Closer to a crash-mid-write or a stray external `mv`: the file vanishes
  // from disk but nothing has committed the deletion, so HEAD still has it.
  // This exercises recoverFromGit's `<hash>:<path>` branch directly, as
  // opposed to the `<hash>^:<path>` fallback the committed-wipe test above hits.
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  hive.writeTasks([fakeTask('t1'), fakeTask('t2'), fakeTask('t3')]);
  assert.equal(readTasks(home).tasks.length, 3);

  fs.rmSync(tasksPathOf(home)); // no git add/commit — HEAD still has the good copy

  await hive.ensureAgent({ id: 'a2', name: 'B', provider: 'claude', cwd: home });

  assert.equal(readTasks(home).tasks.length, 3, 'an uncommitted disk-level wipe must recover just as well as a committed one');
});

test('log.jsonl itself is recovered even when another file is missing in the same pass', async (t) => {
  // log.jsonl carries the audit trail that caught D16 in the first place (a
  // count in the log disagreeing with a file). If it were recovered AFTER
  // registry/board/tasks, an incidental appendLog() call during THEIR recovery
  // would create a fresh, empty-history log.jsonl before log.jsonl's own
  // ensureTrackedFile call ran, silently losing everything before that point.
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const logPath = path.join(home, 'hive', 'log.jsonl');
  const registryPath = path.join(home, 'hive', 'registry.json');
  const before = fs.readFileSync(logPath, 'utf8');
  assert.match(before, /"agentId":"a1"/, 'precondition: a1\'s spawn event is really in the pre-wipe log');

  fs.rmSync(logPath);
  fs.rmSync(registryPath);
  gitIn(home, ['add', '-A']);
  gitIn(home, ['commit', '-q', '-m', 'simulated external wipe of log.jsonl and registry.json together']);

  await hive.ensureAgent({ id: 'a2', name: 'B', provider: 'claude', cwd: home });

  const after = fs.readFileSync(logPath, 'utf8');
  // A weak "more lines than before" check passes even when log.jsonl's real
  // history was discarded, because ensureAgent's own spawn-event append (plus
  // the recovery events logged for OTHER files in the same pass) still grows
  // the line count from a fresh empty file. The only assertion that actually
  // distinguishes "recovered" from "silently replaced" is that a1's specific
  // pre-wipe entry survives into the post-recovery file.
  assert.match(after, /"agentId":"a1"/,
    'a1\'s pre-wipe spawn event must survive recovery, not be replaced by a fresh log starting from this pass\'s events');
  assert.match(after, /"agentId":"a2"/, 'the registration that triggered recovery must still be logged');
});

test('a genuinely fresh hive still bootstraps an empty task board', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });

  assert.deepEqual(readTasks(home), { tasks: [] });
});

test('a missing registry.json on an existing hive is recovered the same way as tasks.json', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const registryPath = path.join(home, 'hive', 'registry.json');
  const before = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(before.agents.a1, 'precondition: a1 is really registered');

  fs.rmSync(registryPath);
  gitIn(home, ['add', '-A']);
  gitIn(home, ['commit', '-q', '-m', 'simulated external wipe of registry.json']);

  await hive.ensureAgent({ id: 'a2', name: 'B', provider: 'claude', cwd: home });

  const after = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(after.agents.a1, 'a1 must survive the recovery, not just a2 being freshly written back in');
  assert.ok(after.agents.a2, 'the registration that triggered recovery must still take effect');
});
