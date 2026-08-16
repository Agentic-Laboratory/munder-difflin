'use strict';

/**
 * MatrixClient transport — the five failure modes that decide whether a
 * self-hosted Matrix bot works or merely LOOKS like it works:
 *
 *   1. E2EE is the showstopper. A plain /sync bot cannot read encrypted rooms,
 *      and Synapse/Element encrypt private rooms by default — so encryption is
 *      detected up front (state probe), via the m.room.encryption state event,
 *      AND via opaque m.room.encrypted timeline events (the only signal that
 *      survives an incremental sync resumed from a persisted token). Every path
 *      must fail LOUDLY, never connect-clean-and-see-nothing.
 *   2. next_batch is persisted, and persisted AFTER dispatch — saving first
 *      would silently drop a batch if delivery throws.
 *   3. The first /sync (no since=) is a backlog snapshot: take its token, fire
 *      on nothing.
 *   4. Echo suppression — the bot sees its own sends in /sync.
 *   5. An empty /sync is the NORMAL idle return and must be re-issued
 *      immediately; backoff applies only to errors.
 *
 * `fetch` and the trigger module are injected, so none of this touches a live
 * homeserver or requires src/main/matrix-trigger.cjs to exist.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  MatrixClient,
  sendMatrixMessage,
  createMemorySyncTokenStore
} = loadTs('src/main/matrix.ts');

const HS = 'https://matrix.example.org';
const TOKEN = 'syt_secret_token_value';
const BOT = '@bot:example.org';
const HUMAN = '@dwight:example.org';
const ROOM = '!room:example.org';

// ── fake homeserver ─────────────────────────────────────────────────────────

function jsonRes(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    headers: { get: () => null }
  };
}

/** A promise that only settles when the caller's abort signal fires — models a
 *  /sync long poll that is still waiting when the test is done with it. */
function park(signal) {
  return new Promise((_resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('aborted')); return; }
    if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

/**
 * @param opts.syncs      scripted /sync responses, consumed in order; after the
 *                        last one the call parks (as a real long poll would).
 * @param opts.encrypted  true → the m.room.encryption state probe answers 200.
 */
function makeHomeserver(opts = {}) {
  const syncs = (opts.syncs || []).slice();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/account/whoami')) return jsonRes(200, { user_id: BOT });
    if (url.includes('/displayname')) return jsonRes(200, { displayname: 'Michael' });
    if (url.includes('/joined_rooms')) {
      return jsonRes(200, { joined_rooms: opts.joinedRooms || [ROOM] });
    }
    if (url.includes('/state/m.room.encryption')) {
      if (opts.stateForbidden) return jsonRes(403, { errcode: 'M_FORBIDDEN', error: 'not in room' });
      return opts.encrypted
        ? jsonRes(200, { algorithm: 'm.megolm.v1.aes-sha2' })
        : jsonRes(404, { errcode: 'M_NOT_FOUND' });
    }
    if (url.includes('/sync')) {
      if (syncs.length === 0) return park(init.signal);
      return jsonRes(200, syncs.shift());
    }
    if (url.includes('/send/m.room.message/')) return jsonRes(200, { event_id: '$sent' });
    return jsonRes(404, { errcode: 'M_UNRECOGNIZED' });
  };
  return {
    fetchImpl,
    calls,
    syncUrls: () => calls.filter((c) => c.url.includes('/sync')).map((c) => c.url)
  };
}

/** Minimal stand-in for matrix-trigger.cjs (owned by another card): a message
 *  triggers when its body starts with `!bot`. */
function makeTrigger() {
  class Bounded {
    constructor() { this._s = new Set(); }
    add(k) { this._s.add(k); }
    has(k) { return this._s.has(k); }
    seen(k) { if (this._s.has(k)) return true; this._s.add(k); return false; }
    get size() { return this._s.size; }
  }
  return {
    ActivatedThreads: Bounded,
    SeenEvents: Bounded,
    shouldTrigger: (ev) => {
      const body = (ev.content && typeof ev.content.body === 'string') ? ev.content.body : '';
      return body.startsWith('!bot')
        ? { trigger: true, text: body.slice(4).trim() }
        : { trigger: false, text: '' };
    }
  };
}

function msgEvent(overrides = {}) {
  return {
    type: 'm.room.message',
    sender: HUMAN,
    event_id: '$evt1',
    origin_server_ts: 1_700_000_000_000,
    content: { msgtype: 'm.text', body: '!bot hello' },
    ...overrides
  };
}

function syncBatch(nextBatch, events, extra = {}) {
  return {
    next_batch: nextBatch,
    rooms: { join: { [ROOM]: { timeline: { events }, state: { events: extra.state || [] } } } }
  };
}

function makeClient(hs, overrides = {}) {
  const received = [];
  const logs = [];
  const errors = [];
  const client = new MatrixClient({
    homeserverUrl: HS,
    accessToken: TOKEN,
    fetchImpl: hs.fetchImpl,
    trigger: makeTrigger(),
    syncTokenStore: createMemorySyncTokenStore(),
    syncTimeoutMs: 20,
    logger: (level, message) => logs.push(`${level}:${message}`),
    onError: (e) => errors.push(e),
    onMessage: (m) => { received.push(m); },
    ...overrides
  });
  return { client, received, logs, errors };
}

/** Poll until `fn()` is truthy — the sync loop runs in the background. */
async function until(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  return fn();
}

// ── TRAP 1: E2EE must fail loudly, never silently ───────────────────────────

test('start() refuses loudly when the configured room is end-to-end encrypted', async () => {
  const hs = makeHomeserver({ encrypted: true });
  const { client, logs, errors } = makeClient(hs, { roomId: ROOM });

  const res = await client.start();
  client.stop();

  assert.equal(res.ok, false, 'must NOT report a healthy start on an encrypted room');
  assert.match(res.error, /ENCRYPTED/i);
  assert.equal(errors.length, 1, 'onError must fire');
  assert.ok(logs.some((l) => l.startsWith('error:')), 'must log at error level');
  assert.equal(client.getStatus().healthy, false);
  assert.equal(hs.syncUrls().length, 0, 'must not even start syncing');
});

test('start() refuses loudly when the bot is not joined to the configured room', async () => {
  // The other way to be blind: the room is plaintext and perfectly readable —
  // the bot simply isn't in it (or the id has a typo). /sync would then run
  // forever, error-free, delivering nothing.
  const hs = makeHomeserver({ joinedRooms: ['!somewhere-else:example.org'] });
  const { client, errors, logs } = makeClient(hs, { roomId: ROOM });

  const res = await client.start();
  client.stop();

  assert.equal(res.ok, false);
  assert.match(res.error, /NOT JOINED/i);
  assert.equal(client.getStatus().healthy, false);
  assert.ok(errors.some((e) => /NOT JOINED/i.test(e)));
  assert.ok(logs.some((l) => l.startsWith('error:')));
  assert.equal(hs.syncUrls().length, 0, 'must not start syncing into a room it cannot see');
});

test('start() refuses when the room state read is forbidden', async () => {
  // Joined per /joined_rooms, but the state endpoint says 403 — treated as
  // "cannot read this room", not as a merely undetermined encryption answer.
  const hs = makeHomeserver({ stateForbidden: true });
  const { client } = makeClient(hs, { roomId: ROOM });

  const res = await client.start();
  client.stop();

  assert.equal(res.ok, false);
  assert.match(res.error, /M_FORBIDDEN|NOT READABLE/i);
  assert.equal(client.getStatus().healthy, false);
});

test('opaque m.room.encrypted events mark a room unreadable and skip it', async () => {
  // The room reports "not encrypted" from the state endpoint (a server that
  // hides state, or a room encrypted before our persisted token) — the ONLY
  // remaining signal is the encrypted timeline event itself.
  const hs = makeHomeserver({
    encrypted: false,
    syncs: [
      syncBatch('s0', []), // priming snapshot
      syncBatch('s1', [
        { type: 'm.room.encrypted', sender: HUMAN, event_id: '$enc', content: {} },
        msgEvent() // would otherwise trigger — must be skipped
      ])
    ]
  });
  const { client, received, errors } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  await until(() => client.getStatus().encryptedRooms.length > 0);
  const status = client.getStatus();
  client.stop();

  assert.deepEqual(status.encryptedRooms, [ROOM]);
  assert.equal(received.length, 0, 'must not emit from an encrypted room');
  assert.equal(status.readableRooms, 0);
  assert.equal(status.healthy, false, 'a bot that can read nothing must NOT look healthy');
  assert.ok(errors.some((e) => /ENCRYPTED/i.test(e)), 'must surface the failure to the caller');
});

test('an m.room.encryption state event also marks the room unreadable', async () => {
  const hs = makeHomeserver({
    encrypted: false,
    syncs: [
      syncBatch('s0', []),
      syncBatch('s1', [msgEvent()], {
        state: [{ type: 'm.room.encryption', state_key: '', sender: HUMAN, event_id: '$e' }]
      })
    ]
  });
  const { client, received } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  await until(() => client.getStatus().encryptedRooms.length > 0);
  client.stop();

  assert.deepEqual(client.getStatus().encryptedRooms, [ROOM]);
  assert.equal(received.length, 0);
});

// ── TRAP 3: the first /sync is a backlog snapshot, not a firehose ───────────

test('the initial /sync takes its token and fires on NO room history', async () => {
  const backlog = [
    msgEvent({ event_id: '$old1', content: { body: '!bot ancient request' } }),
    msgEvent({ event_id: '$old2', content: { body: '!bot another old one' } })
  ];
  const hs = makeHomeserver({ syncs: [syncBatch('snapshot-token', backlog)] });
  const store = createMemorySyncTokenStore();
  const { client, received } = makeClient(hs, { syncTokenStore: store });

  assert.equal((await client.start()).ok, true);
  await until(() => hs.syncUrls().length >= 2);
  client.stop();

  assert.equal(received.length, 0, 'must not replay room history on boot');
  assert.equal(store.load(), 'snapshot-token', 'but must keep the token');
  assert.match(hs.syncUrls()[0], /timeout=0/, 'priming sync is a non-blocking snapshot');
  assert.ok(!hs.syncUrls()[0].includes('since='), 'priming sync has no since=');
  assert.match(hs.syncUrls()[1], /since=snapshot-token/, 'the loop resumes from it');
});

// ── TRAP 2: next_batch persists, and is saved AFTER dispatch ────────────────

test('a persisted next_batch is resumed instead of re-snapshotting', async () => {
  const hs = makeHomeserver({ syncs: [syncBatch('s1', [])] });
  const { client } = makeClient(hs, { syncTokenStore: createMemorySyncTokenStore('saved-token') });

  assert.equal((await client.start()).ok, true);
  await until(() => hs.syncUrls().length >= 1);
  client.stop();

  assert.match(hs.syncUrls()[0], /since=saved-token/, 'must resume, not re-snapshot');
  assert.ok(!hs.syncUrls()[0].includes('timeout=0'), 'no priming sync when resuming');
});

test('next_batch is saved AFTER the batch is dispatched, never before', async () => {
  const order = [];
  const hs = makeHomeserver({
    syncs: [syncBatch('s0', []), syncBatch('batch-1', [msgEvent()])]
  });
  const store = {
    load: () => null,
    save: (t) => order.push(`save:${t}`)
  };
  const { client } = makeClient(hs, {
    syncTokenStore: store,
    onMessage: () => { order.push('dispatch'); }
  });

  assert.equal((await client.start()).ok, true);
  await until(() => order.includes('save:batch-1'));
  client.stop();

  // Saving before dispatch would silently DROP the batch on a crash mid-delivery.
  assert.deepEqual(order, ['save:s0', 'dispatch', 'save:batch-1']);
});

// ── TRAP 4: echo suppression ────────────────────────────────────────────────

test('the bot never fires on its own messages', async () => {
  const hs = makeHomeserver({
    syncs: [
      syncBatch('s0', []),
      syncBatch('s1', [
        msgEvent({ sender: BOT, event_id: '$mine', content: { body: '!bot echo of myself' } }),
        msgEvent({ sender: HUMAN, event_id: '$theirs', content: { body: '!bot real request' } })
      ])
    ]
  });
  const { client, received } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  await until(() => received.length > 0);
  client.stop();

  assert.equal(received.length, 1, 'exactly the human message — no self-reply loop');
  assert.equal(received[0].sender, HUMAN);
  assert.equal(received[0].text, 'real request', 'trigger text is normalized');
  assert.equal(received[0].roomId, ROOM);
  assert.equal(received[0].threadRootId, '$theirs', 'non-threaded message roots its own thread');
});

test('a duplicate event_id is delivered only once, and edits do not re-fire', async () => {
  const dup = msgEvent({ event_id: '$same' });
  const edit = msgEvent({
    event_id: '$edit',
    content: {
      body: '!bot edited text',
      'm.relates_to': { rel_type: 'm.replace', event_id: '$same' }
    }
  });
  const hs = makeHomeserver({
    syncs: [syncBatch('s0', []), syncBatch('s1', [dup]), syncBatch('s2', [dup, edit])]
  });
  const { client, received } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  await until(() => hs.syncUrls().length >= 4);
  client.stop();

  assert.equal(received.length, 1, 'event_id dedup + m.replace filter');
});

test('a thread reply reports the thread root, not its own event id', async () => {
  const hs = makeHomeserver({
    syncs: [syncBatch('s0', []), syncBatch('s1', [msgEvent({
      event_id: '$reply',
      content: {
        body: '!bot in a thread',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }
      }
    })])]
  });
  const { client, received } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  await until(() => received.length > 0);
  client.stop();

  assert.equal(received[0].threadRootId, '$root');
});

// ── TRAP 5: an empty /sync is normal and must NOT trigger backoff ───────────

test('empty /sync returns are re-issued immediately, with no backoff', async () => {
  const hs = makeHomeserver({
    syncs: [syncBatch('s0', []), syncBatch('s1', []), syncBatch('s2', []), syncBatch('s3', [])]
  });
  const { client } = makeClient(hs);

  const startedAt = Date.now();
  assert.equal((await client.start()).ok, true);
  await until(() => hs.syncUrls().length >= 4);
  const elapsed = Date.now() - startedAt;
  const status = client.getStatus();
  client.stop();

  // The first error backoff is 1s; three idle syncs finishing well inside that
  // proves idleness is not being treated as failure.
  assert.ok(elapsed < 900, `idle syncs must not back off (took ${elapsed}ms)`);
  assert.ok(status.syncCount >= 3);
  assert.equal(status.lastError, null);
});

test('a 429 waits the server-supplied retry_after_ms exactly once', async () => {
  // The bug this guards: sleeping retry_after_ms inside the request AND then
  // falling into the generic error backoff, waiting twice and escalating the
  // backoff on top of an explicit instruction from the server.
  let rateLimited = false;
  const hs = makeHomeserver({ syncs: [syncBatch('s0', []), syncBatch('s1', [])] });
  const inner = hs.fetchImpl;
  hs.fetchImpl = async (url, init) => {
    if (url.includes('/sync') && url.includes('since=') && !rateLimited) {
      rateLimited = true;
      return jsonRes(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 40 });
    }
    return inner(url, init);
  };
  const { client } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  const startedAt = Date.now();
  await until(() => client.getStatus().syncCount >= 1);
  const elapsed = Date.now() - startedAt;
  client.stop();

  assert.ok(rateLimited, 'the 429 was actually served');
  // One 40ms wait, not 40ms + a 1000ms error backoff.
  assert.ok(elapsed < 800, `must honour retry_after_ms once (waited ${elapsed}ms)`);
  assert.equal(client.getStatus().syncCount >= 1, true, 'and then recover');
});

test('a 401 stops the loop loudly instead of retrying an invalid token forever', async () => {
  let syncCalls = 0;
  const hs = makeHomeserver({ syncs: [syncBatch('s0', [])] });
  const inner = hs.fetchImpl;
  hs.fetchImpl = async (url, init) => {
    if (url.includes('/sync') && url.includes('since=')) {
      syncCalls += 1;
      return jsonRes(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token' });
    }
    return inner(url, init);
  };
  const { client, errors } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  await until(() => client.getStatus().fatalError !== null);
  const status = client.getStatus();
  client.stop();

  assert.match(status.fatalError, /401/);
  assert.equal(status.running, false);
  assert.equal(status.healthy, false);
  assert.equal(syncCalls, 1, 'must not spin on a token that will never work');
  assert.ok(errors.length >= 1);
});

// ── outbound ────────────────────────────────────────────────────────────────

test('sendMatrixMessage PUTs m.room.message with a unique txnId and bearer auth', async () => {
  const hs = makeHomeserver();
  const a = await sendMatrixMessage({
    homeserverUrl: `${HS}/`, accessToken: TOKEN, roomId: ROOM, text: 'hi', fetchImpl: hs.fetchImpl
  });
  const b = await sendMatrixMessage({
    homeserverUrl: HS, accessToken: TOKEN, roomId: ROOM, text: 'hi again', fetchImpl: hs.fetchImpl
  });

  assert.equal(a.ok, true);
  assert.equal(a.eventId, '$sent');
  const sends = hs.calls.filter((c) => c.url.includes('/send/m.room.message/'));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].init.method, 'PUT');
  assert.equal(sends[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!sends[0].url.includes('//_matrix'), 'trailing slash on the base url is normalized');
  assert.ok(sends[0].url.includes(encodeURIComponent(ROOM)), 'room id is url-encoded');
  // A repeated txnId means the homeserver silently swallows the second send.
  assert.notEqual(sends[0].url, sends[1].url, 'each send needs its own transaction id');
  assert.equal(b.ok, true);
  assert.equal(JSON.parse(sends[0].init.body).msgtype, 'm.text');
});

test('sendMatrixMessage nests a reply in its thread', async () => {
  const hs = makeHomeserver();
  await sendMatrixMessage({
    homeserverUrl: HS, accessToken: TOKEN, roomId: ROOM, text: 'reply',
    threadRootId: '$root', replyToEventId: '$latest', fetchImpl: hs.fetchImpl
  });
  const body = JSON.parse(hs.calls.find((c) => c.url.includes('/send/')).init.body);
  assert.deepEqual(body['m.relates_to'], {
    rel_type: 'm.thread',
    event_id: '$root',
    is_falling_back: true,
    'm.in_reply_to': { event_id: '$latest' }
  });
});

test('sendMatrixMessage refuses an implicit destination and never leaks the token', async () => {
  const hs = makeHomeserver();
  const noRoom = await sendMatrixMessage({
    homeserverUrl: HS, accessToken: TOKEN, roomId: '  ', text: 'x', fetchImpl: hs.fetchImpl
  });
  assert.deepEqual(noRoom, { ok: false, error: 'missing room id' });

  const failing = {
    ...hs,
    fetchImpl: async () => jsonRes(403, { errcode: 'M_FORBIDDEN', error: 'not in room' })
  };
  const denied = await sendMatrixMessage({
    homeserverUrl: HS, accessToken: TOKEN, roomId: ROOM, text: 'x', fetchImpl: failing.fetchImpl
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /M_FORBIDDEN/);
  assert.ok(!denied.error.includes(TOKEN), 'the access token must never appear in an error');
  assert.equal(hs.calls.length, 0, 'no request is made without an explicit room');
});

test('client.sendMessage uses the instance credentials', async () => {
  const hs = makeHomeserver();
  const { client } = makeClient(hs);
  const res = await client.sendMessage(ROOM, 'from the client', { threadRootId: '$root' });

  assert.equal(res.ok, true);
  const send = hs.calls.find((c) => c.url.includes('/send/'));
  assert.equal(send.init.headers.authorization, `Bearer ${TOKEN}`);
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test('start() is not repeatable and stop() is idempotent', async () => {
  const hs = makeHomeserver({ syncs: [syncBatch('s0', [])] });
  const { client } = makeClient(hs);

  assert.equal((await client.start()).ok, true);
  assert.deepEqual(await client.start(), { ok: false, error: 'already running' });
  client.stop();
  client.stop();
  assert.equal(client.getStatus().running, false);
});

test('onMessage() registers extra listeners and unsubscribes', async () => {
  const hs = makeHomeserver({ syncs: [syncBatch('s0', []), syncBatch('s1', [msgEvent()])] });
  const { client, received } = makeClient(hs);
  const extra = [];
  const off = client.onMessage((m) => { extra.push(m); });

  assert.equal((await client.start()).ok, true);
  await until(() => extra.length > 0);
  off();
  client.stop();

  assert.equal(extra.length, 1);
  assert.equal(received.length, 1, 'the constructor listener still fires');
});

test('a missing access token or homeserver is refused before any request', async () => {
  const hs = makeHomeserver();
  const bare = new MatrixClient({
    homeserverUrl: HS, accessToken: '', fetchImpl: hs.fetchImpl,
    trigger: makeTrigger(), syncTokenStore: createMemorySyncTokenStore(), logger: () => {}
  });
  assert.deepEqual(await bare.start(), { ok: false, error: 'missing access token' });
  assert.equal(hs.calls.length, 0);
});
