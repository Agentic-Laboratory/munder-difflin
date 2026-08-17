'use strict';

/**
 * Matrix mention/thread/dedup trigger logic — ported from slack-trigger.cjs.
 * Covers the semantics that differ from Slack: m.mentions (+ pill/mxid body
 * fallback), m.relates_to thread/replace relations, event_id dedup, and the
 * critical echo-suppression guard (the bot must never re-trigger on its own
 * sends coming back through /sync).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldTrigger,
  normalizeRoomFilter,
  ActivatedThreads,
  SeenEvents,
  dedupKey,
  ACTIVATED_THREADS_MAX,
  SEEN_EVENTS_MAX,
} = require('../src/main/matrix-trigger.cjs');

const BOT_ID = '@bot:server.tld';
const ROOM = '!abc:server.tld';

function ev(overrides = {}) {
  const { content: contentOverrides, ...rest } = overrides;
  return {
    type: 'm.room.message',
    room_id: ROOM,
    sender: '@alice:server.tld',
    event_id: '$1000',
    content: {
      msgtype: 'm.text',
      body: 'hello',
      ...contentOverrides,
    },
    ...rest,
  };
}

test('plain message with no mention and no active thread → NOT triggered', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(ev({ content: { body: 'hello world' } }), BOT_ID, null, threads);
  assert.equal(result.trigger, false);
  assert.equal(threads.size, 0, 'thread must not be activated');
});

test('m.mentions.user_ids includes bot → triggered and thread root activated', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ event_id: '$1001', content: { body: 'please help', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true);
  assert.equal(result.text, 'please help');
  assert.ok(threads.has('$1001'), 'message event_id activated as thread root');
});

test('matrix.to pill in body (no m.mentions) → triggered — older-client fallback', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ event_id: '$1002', content: { body: `hey https://matrix.to/#/${BOT_ID} please help` } }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true);
  assert.ok(threads.has('$1002'));
});

test('bare mxid as plain text, with no pill → NOT triggered (avoids false positives on incidental mentions)', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ event_id: '$1003', content: { body: `who owns ${BOT_ID} these days?` } }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, false, 'an unguarded substring match would fire on any incidental mention');
});

test('matrix.to pill only in formatted_body → triggered', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({
      event_id: '$1004',
      content: {
        body: 'please help',
        formatted_body: `<a href="https://matrix.to/#/${BOT_ID}">Bot</a> please help`,
      },
    }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true);
});

test('quoted pill in a reply-fallback body (plain text) → does NOT re-trigger', () => {
  const threads = new ActivatedThreads();
  const body = `> <@alice:server.tld> https://matrix.to/#/${BOT_ID} earlier question\n\njust replying to alice, not the bot`;
  const result = shouldTrigger(ev({ event_id: '$1005', content: { body } }), BOT_ID, null, threads);
  assert.equal(result.trigger, false, 'the pill lives only in the quoted fallback, not the new content');
});

test('quoted pill in an mx-reply formatted_body fallback → does NOT re-trigger', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({
      event_id: '$1006',
      content: {
        body: 'just replying to alice',
        formatted_body: `<mx-reply><a href="https://matrix.to/#/${BOT_ID}">Bot</a> earlier question</mx-reply>just replying to alice`,
      },
    }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, false);
});

test('a fresh pill mention OUTSIDE the quoted fallback still triggers', () => {
  const threads = new ActivatedThreads();
  const body = `> <@alice:server.tld> earlier question\n\nhttps://matrix.to/#/${BOT_ID} can you help with this?`;
  const result = shouldTrigger(ev({ event_id: '$1007', content: { body } }), BOT_ID, null, threads);
  assert.equal(result.trigger, true, 'a genuine new-content mention past the fallback must still fire');
});

test('reply in activated thread without re-mention → triggered', () => {
  const threads = new ActivatedThreads();
  shouldTrigger(
    ev({ event_id: '$2001', content: { body: 'start', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  assert.ok(threads.has('$2001'));
  const result = shouldTrigger(
    ev({
      event_id: '$2002',
      content: { body: 'follow-up question', 'm.relates_to': { rel_type: 'm.thread', event_id: '$2001' } },
    }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true, 'thread reply should trigger');
  assert.equal(result.text, 'follow-up question');
});

test('mention inside a threaded reply activates the thread ROOT, not the reply event_id', () => {
  const threads = new ActivatedThreads();
  const rootId = '$3000';
  const replyId = '$3099';
  const result = shouldTrigger(
    ev({
      event_id: replyId,
      content: {
        body: 'help in thread',
        'm.mentions': { user_ids: [BOT_ID] },
        'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
      },
    }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true);
  assert.ok(threads.has(rootId), 'thread root activated');
  assert.ok(!threads.has(replyId), 'reply event_id not stored as root');
});

test('ECHO SUPPRESSION: sender === ownUserId → NOT triggered even with an explicit mention', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ sender: BOT_ID, content: { body: 'hi', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, false, 'bot must never re-trigger on its own send');
  assert.equal(threads.size, 0, 'own mention must not activate a thread either');
});

test('ECHO SUPPRESSION: bot reply inside an activated thread → NOT triggered', () => {
  const threads = new ActivatedThreads();
  shouldTrigger(
    ev({ event_id: '$4001', content: { body: 'start', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  const result = shouldTrigger(
    ev({
      event_id: '$4002',
      sender: BOT_ID,
      content: { body: 'bot reply', 'm.relates_to': { rel_type: 'm.thread', event_id: '$4001' } },
    }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, false, 'bot reply must not loop back');
});

test('edit (m.relates_to rel_type m.replace) → NOT triggered even if it mentions the bot', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({
      content: {
        body: ' * hi bot edited',
        'm.mentions': { user_ids: [BOT_ID] },
        'm.new_content': { msgtype: 'm.text', body: 'hi bot edited' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$1000' },
      },
    }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, false);
});

test('non-message event types (reaction, state event) → NOT triggered', () => {
  const threads = new ActivatedThreads();
  const reaction = shouldTrigger(
    { type: 'm.reaction', room_id: ROOM, sender: '@alice:server.tld', event_id: '$5001', content: {} },
    BOT_ID, null, threads
  );
  assert.equal(reaction.trigger, false);

  const memberEvent = shouldTrigger(
    { type: 'm.room.member', room_id: ROOM, sender: '@alice:server.tld', event_id: '$5002', content: { membership: 'join' } },
    BOT_ID, null, threads
  );
  assert.equal(memberEvent.trigger, false);
});

test('room filter: wrong room_id → NOT triggered even with mention', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ room_id: '!other:server.tld', content: { body: 'help', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, ROOM, threads
  );
  assert.equal(result.trigger, false);
  assert.equal(threads.size, 0, 'wrong-room mention must not activate thread');
});

test('room filter: matching room_id → triggered', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ content: { body: 'help', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, ROOM, threads
  );
  assert.equal(result.trigger, true);
});

test('no room filter (null) → any room triggers', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ room_id: '!random:server.tld', content: { body: 'hi', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true);
});

test('ownUserId null → m.mentions/pill checks skip gracefully, no crash, no false positive', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ content: { body: `hi ${BOT_ID}`, 'm.mentions': { user_ids: [BOT_ID] } } }),
    null, null, threads
  );
  assert.equal(result.trigger, false);
});

test('null/undefined event → NOT triggered', () => {
  const threads = new ActivatedThreads();
  assert.equal(shouldTrigger(null, BOT_ID, null, threads).trigger, false);
  assert.equal(shouldTrigger(undefined, BOT_ID, null, threads).trigger, false);
});

test('malformed content (missing/non-object) → NOT triggered, does not throw', () => {
  const threads = new ActivatedThreads();
  assert.doesNotThrow(() => {
    const result = shouldTrigger({ type: 'm.room.message', room_id: ROOM, sender: '@alice:server.tld', event_id: '$6001' }, BOT_ID, null, threads);
    assert.equal(result.trigger, false);
  });
});

test('activatedThreads evicts oldest when cap is reached (bounded FIFO)', () => {
  const maxSize = 3;
  const threads = new ActivatedThreads(maxSize);
  threads.add('t1'); threads.add('t2'); threads.add('t3');
  assert.equal(threads.size, maxSize);
  threads.add('t4');
  assert.equal(threads.size, maxSize, 'size stays at cap');
  assert.ok(!threads.has('t1'), 't1 evicted');
  assert.ok(threads.has('t2'));
  assert.ok(threads.has('t3'));
  assert.ok(threads.has('t4'));
});

test('default ActivatedThreads cap is ACTIVATED_THREADS_MAX', () => {
  assert.equal(ACTIVATED_THREADS_MAX, 500);
  const threads = new ActivatedThreads();
  for (let i = 0; i <= ACTIVATED_THREADS_MAX; i++) threads.add(`t${i}`);
  assert.equal(threads.size, ACTIVATED_THREADS_MAX);
  assert.ok(!threads.has('t0'), 't0 evicted');
  assert.ok(threads.has(`t${ACTIVATED_THREADS_MAX}`));
});

// ─── Media attachments ────────────────────────────────────────────────────

function imageEvent({ eventId = '$7001', mentions = false, threadRoot = undefined } = {}) {
  const content = {
    msgtype: 'm.image',
    body: 'photo.png',
    url: 'mxc://server.tld/abc123',
    info: { mimetype: 'image/png', size: 102400 },
  };
  if (mentions) content['m.mentions'] = { user_ids: [BOT_ID] };
  if (threadRoot) content['m.relates_to'] = { rel_type: 'm.thread', event_id: threadRoot };
  return ev({ event_id: eventId, content });
}

test('media message (m.image) + mention → triggered and file metadata extracted', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(imageEvent({ mentions: true }), BOT_ID, null, threads);
  assert.equal(result.trigger, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].url, 'mxc://server.tld/abc123');
  assert.equal(result.files[0].name, 'photo.png');
  assert.equal(result.files[0].mimetype, 'image/png');
  assert.equal(result.files[0].size, 102400);
});

test('media message in activated thread (no re-mention) → triggered with file extracted', () => {
  const threads = new ActivatedThreads();
  shouldTrigger(
    ev({ event_id: '$7100', content: { body: 'start', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  const result = shouldTrigger(imageEvent({ eventId: '$7101', threadRoot: '$7100' }), BOT_ID, null, threads);
  assert.equal(result.trigger, true);
  assert.equal(result.files.length, 1);
});

test('media message with no mention and no activated thread → NOT triggered, no files', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(imageEvent(), BOT_ID, null, threads);
  assert.equal(result.trigger, false);
  assert.equal(result.files.length, 0);
});

test('non-media msgtype (m.text) never yields files even when triggered', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ content: { body: 'hi', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true);
  assert.deepEqual(result.files, []);
});

test('media content.url missing mxc:// scheme is not extracted as a file', () => {
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ content: { msgtype: 'm.image', body: 'x', url: 'https://not-mxc.example/x', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, null, threads
  );
  assert.equal(result.trigger, true);
  assert.deepEqual(result.files, []);
});

// ─── dedup ──────────────────────────────────────────────────────────────────

test('dedupKey returns the event_id', () => {
  assert.equal(dedupKey(ev({ event_id: '$abc' })), '$abc');
});

test('dedupKey returns "" when event_id is missing or event is null', () => {
  assert.equal(dedupKey(ev({ event_id: undefined })), '');
  assert.equal(dedupKey(null), '');
});

test('SeenEvents.seen: first occurrence false (new), repeat true (duplicate)', () => {
  const seen = new SeenEvents();
  assert.equal(seen.seen('$100'), false);
  assert.equal(seen.seen('$100'), true);
  assert.equal(seen.seen('$101'), false);
});

test('SeenEvents never dedupes empty/falsy keys and does not store them', () => {
  const seen = new SeenEvents();
  assert.equal(seen.seen(''), false);
  assert.equal(seen.seen(''), false);
  assert.equal(seen.size, 0);
});

test('SeenEvents is bounded FIFO — oldest key evicted past the cap', () => {
  const seen = new SeenEvents(3);
  seen.seen('a'); seen.seen('b'); seen.seen('c');
  assert.equal(seen.size, 3);
  seen.seen('d'); // evicts 'a'
  assert.equal(seen.size, 3);
  assert.equal(seen.seen('a'), false, 'evicted "a" is treated as new again');
  assert.equal(seen.seen('c'), true, '"c" still remembered');
});

test('SEEN_EVENTS_MAX default is exported and sane', () => {
  assert.equal(typeof SEEN_EVENTS_MAX, 'number');
  assert.ok(SEEN_EVENTS_MAX >= 100);
});

test('integration: /sync retry redelivering the SAME event_id fires onMessage once', () => {
  const threads = new ActivatedThreads();
  const seen = new SeenEvents();
  let fires = 0;
  const ingest = (event) => {
    const { trigger } = shouldTrigger(event, BOT_ID, ROOM, threads);
    if (!trigger) return;
    const key = dedupKey(event);
    if (key && seen.seen(key)) return; // duplicate — skip
    fires++;
  };
  const duped = ev({ event_id: '$8001', content: { body: 'ship it', 'm.mentions': { user_ids: [BOT_ID] } } });
  ingest(duped);
  ingest(duped); // /sync retry redelivers the identical event
  assert.equal(fires, 1, 'onMessage fires exactly once for the redelivered event');
});

test('integration: a genuinely new event still fires after a duplicate', () => {
  const threads = new ActivatedThreads();
  const seen = new SeenEvents();
  let fires = 0;
  const ingest = (event) => {
    const { trigger } = shouldTrigger(event, BOT_ID, ROOM, threads);
    if (!trigger) return;
    const key = dedupKey(event);
    if (key && seen.seen(key)) return;
    fires++;
  };
  const first = ev({ event_id: '$9001', content: { body: 'one', 'm.mentions': { user_ids: [BOT_ID] } } });
  ingest(first);
  ingest(first); // dup
  ingest(ev({ event_id: '$9002', content: { body: 'two', 'm.mentions': { user_ids: [BOT_ID] } } })); // new
  assert.equal(fires, 2, 'distinct event_ids each fire once');
});

test('integration: echo suppression prevents an infinite reply loop end-to-end', () => {
  const threads = new ActivatedThreads();
  const seen = new SeenEvents();
  let fires = 0;
  const ingest = (event) => {
    const { trigger } = shouldTrigger(event, BOT_ID, ROOM, threads);
    if (!trigger) return;
    const key = dedupKey(event);
    if (key && seen.seen(key)) return;
    fires++;
  };
  // User mentions the bot in a thread.
  ingest(ev({ event_id: '$A001', content: { body: 'help', 'm.mentions': { user_ids: [BOT_ID] } } }));
  // Bot posts its reply into the now-activated thread — /sync echoes it back.
  ingest(ev({
    event_id: '$A002',
    sender: BOT_ID,
    content: { body: 'here you go', 'm.relates_to': { rel_type: 'm.thread', event_id: '$A001' } },
  }));
  assert.equal(fires, 1, 'only the user message fires; the bot echo must not');
});

// ─── F2: plural room filter ──────────────────────────────────────────────────
// The config field is `matrixRoomIds` (an array) while shouldTrigger originally
// took a singular id. The filter is now normalized in one place and accepts
// both spellings; these lock that reconciliation down.

test('normalizeRoomFilter maps every accepted shape onto a Set or null', () => {
  assert.equal(normalizeRoomFilter(null), null, 'null → no filter');
  assert.equal(normalizeRoomFilter(undefined), null, 'undefined → no filter');
  assert.equal(normalizeRoomFilter(''), null, 'empty string → no filter');
  assert.equal(normalizeRoomFilter([]), null, 'empty array → no filter');
  assert.equal(normalizeRoomFilter(['  ', '']), null, 'blank-only array → no filter');

  assert.deepEqual(normalizeRoomFilter(ROOM), new Set([ROOM]));
  assert.deepEqual(normalizeRoomFilter([ROOM, '!b:server.tld']), new Set([ROOM, '!b:server.tld']));
  assert.deepEqual(normalizeRoomFilter(new Set([ROOM])), new Set([ROOM]));
  assert.deepEqual(normalizeRoomFilter([` ${ROOM} `, '', null]), new Set([ROOM]),
    'entries are trimmed and blanks/non-strings dropped');
});

test('array room filter admits every listed room and rejects the rest', () => {
  const other = '!other:server.tld';
  const rooms = [ROOM, other];
  const mention = { body: 'ping', 'm.mentions': { user_ids: [BOT_ID] } };

  const threads = new ActivatedThreads();
  assert.equal(
    shouldTrigger(ev({ event_id: '$F201', content: mention }), BOT_ID, rooms, threads).trigger,
    true, 'first configured room triggers');
  assert.equal(
    shouldTrigger(ev({ event_id: '$F202', room_id: other, content: mention }), BOT_ID, rooms, threads).trigger,
    true, 'second configured room triggers');
  assert.equal(
    shouldTrigger(ev({ event_id: '$F203', room_id: '!nope:server.tld', content: mention }), BOT_ID, rooms, threads).trigger,
    false, 'an unlisted room is filtered out');
  assert.equal(threads.size, 2, 'only the two admitted messages activated a thread');
});

test('a Set room filter behaves identically to the array form', () => {
  const threads = new ActivatedThreads();
  const mention = { body: 'ping', 'm.mentions': { user_ids: [BOT_ID] } };
  assert.equal(
    shouldTrigger(ev({ event_id: '$F204', content: mention }), BOT_ID, new Set([ROOM]), threads).trigger, true);
  assert.equal(
    shouldTrigger(ev({ event_id: '$F205', room_id: '!x:server.tld', content: mention }), BOT_ID, new Set([ROOM]), threads).trigger, false);
});

test('an empty room list means "any room", matching the config default of []', () => {
  const threads = new ActivatedThreads();
  const mention = { body: 'ping', 'm.mentions': { user_ids: [BOT_ID] } };
  assert.equal(
    shouldTrigger(ev({ event_id: '$F206', room_id: '!anywhere:server.tld', content: mention }), BOT_ID, [], threads).trigger,
    true, 'no configured rooms → unfiltered, same as the singular null case');
});

test('the room filter is applied before echo suppression cannot be bypassed', () => {
  // A bot echo arriving from a CONFIGURED room must still be suppressed — the
  // widened filter must not have reordered the guards.
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ event_id: '$F207', sender: BOT_ID, content: { body: 'mine', 'm.mentions': { user_ids: [BOT_ID] } } }),
    BOT_ID, [ROOM], threads
  );
  assert.equal(result.trigger, false);
  assert.equal(threads.size, 0);
});

test('ownDisplayName is accepted and deliberately does NOT match on its own', () => {
  // Passing a 5th argument must not throw (matrix.ts always passes one), and a
  // bare display name in the body must NOT be treated as a mention — that is
  // the unguarded-substring hazard bodyMentionsUser already refuses for mxids.
  const threads = new ActivatedThreads();
  const result = shouldTrigger(
    ev({ event_id: '$F208', content: { body: 'Michael, can you look at this?' } }),
    BOT_ID, [ROOM], threads, 'Michael'
  );
  assert.equal(result.trigger, false);
  assert.equal(threads.size, 0);
});
