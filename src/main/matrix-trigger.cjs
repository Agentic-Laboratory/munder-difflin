'use strict';

// Pure trigger-decision logic for the Matrix mention filter.
// Extracted as plain CommonJS so test/matrix-trigger.test.cjs can require() it
// directly without a TypeScript compile step — same pattern as slack-trigger.cjs,
// whose design this ports. Matrix semantics differ from Slack in five ways that
// matter here:
//   1. No app_mention event — mentions live in content['m.mentions'].user_ids;
//      older clients only leave a matrix.to pill (or raw mxid) in the body/
//      formatted_body, so both forms are checked.
//   2. Threads are content['m.relates_to'] with rel_type 'm.thread' and an
//      event_id root — not Slack's thread_ts.
//   3. event_id is the dedup key (Matrix has no dual-subscription double-fire,
//      but /sync can redeliver on retry after a dropped response).
//   4. ECHO SUPPRESSION IS CRITICAL: the bot's own sends come back through
//      /sync like any other event. shouldTrigger MUST return false when
//      sender === ownUserId or the bot replies to itself forever.
//   5. Edits (m.relates_to rel_type 'm.replace') must never (re)trigger —
//      the Matrix analogue of Slack's message_changed subtype exclusion.
//
// Responsibilities:
//   - shouldTrigger: self-loop safety, room filter, edit exclusion, mention/
//     activated-thread check
//   - activatedThreads: bounded FIFO set of thread-root event_ids where the
//     bot was mentioned
//   - dedupKey / SeenEvents: idempotency cache keyed on event_id

/** Maximum number of thread roots to remember. FIFO eviction above this limit
 *  prevents unbounded memory growth in long-running bots. */
const ACTIVATED_THREADS_MAX = 500;
/** Maximum number of recently-seen event identities to remember for dedup.
 *  FIFO eviction above this caps memory in long-running bots. */
const SEEN_EVENTS_MAX = 500;

/**
 * Bounded FIFO set of thread-root event_ids where the bot was @-mentioned.
 * Once the bot is mentioned in a thread, all subsequent replies in that
 * thread trigger onMessage — until the entry is FIFO-evicted.
 */
class ActivatedThreads {
  constructor(maxSize = ACTIVATED_THREADS_MAX) {
    this.maxSize = maxSize;
    this._set = new Set();
    this._order = []; // FIFO eviction queue — parallel to _set
  }

  add(rootEventId) {
    if (this._set.has(rootEventId)) return; // already tracked
    if (this._set.size >= this.maxSize) {
      const oldest = this._order.shift();
      if (oldest !== undefined) this._set.delete(oldest);
    }
    this._set.add(rootEventId);
    this._order.push(rootEventId);
  }

  has(rootEventId) { return this._set.has(rootEventId); }
  get size()       { return this._set.size; }
}

/**
 * Bounded FIFO set used as an idempotency cache. Remembers recently-processed
 * event_ids so a /sync retry that redelivers the same event (e.g. after a
 * dropped response before next_batch was persisted) only fires onMessage once.
 */
class SeenEvents {
  constructor(maxSize = SEEN_EVENTS_MAX) {
    this.maxSize = maxSize;
    this._set = new Set();
    this._order = []; // FIFO eviction queue — parallel to _set
  }

  /**
   * Record `key` and report whether it was ALREADY present.
   * @returns {boolean} true if `key` was seen before (caller should skip as a
   *          duplicate); false if it is new (now recorded — caller should process).
   *          Empty/falsy keys are never deduped: they always return false and are
   *          not stored (so a malformed event can't poison or fill the cache).
   */
  seen(key) {
    if (!key) return false;
    if (this._set.has(key)) return true;
    if (this._set.size >= this.maxSize) {
      const oldest = this._order.shift();
      if (oldest !== undefined) this._set.delete(oldest);
    }
    this._set.add(key);
    this._order.push(key);
    return false;
  }

  get size() { return this._set.size; }
}

/**
 * Stable identity for a Matrix event. Unlike Slack (where the same logical
 * message can arrive as two differently-shaped deliveries and needs a
 * composite channel:ts key), a Matrix event_id is already a unique key on its
 * own — it only needs guarding against redelivery on /sync retry.
 *
 * @returns {string} `ev.event_id`, or '' when missing (uncacheable).
 */
function dedupKey(ev) {
  if (!ev) return '';
  return typeof ev.event_id === 'string' ? ev.event_id : '';
}

/**
 * Strip the Matrix rich-reply quote fallback from a plain `body` before
 * mention-scanning it. Per the client-server spec, a reply's fallback is the
 * quoted parent as "> "-prefixed lines followed by a blank line, then the
 * actual new content. Without this, a pill quoted from an EARLIER mention
 * re-appears in every subsequent reply's body and would re-trigger forever —
 * the plain-text analogue of the echo-suppression trap.
 */
function stripReplyFallback(body) {
  const splitAt = body.indexOf('\n\n');
  if (splitAt === -1) return body;
  const quoted = body.slice(0, splitAt).split('\n');
  const isQuoteBlock = quoted.every((line) => line.startsWith('> '));
  return isQuoteBlock ? body.slice(splitAt + 2) : body;
}

/** Same fallback-stripping, for the HTML `<mx-reply>...</mx-reply>` wrapper used in formatted_body. */
function stripFormattedReplyFallback(formattedBody) {
  return formattedBody.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/i, '');
}

/**
 * True if `content` mentions `ownUserId` via the body/formatted_body pill
 * fallback: a matrix.to permalink for the user, left by clients that don't
 * populate m.mentions. Deliberately does NOT match the bare mxid as plain
 * text — an unguarded substring match fires on any incidental mention of the
 * bot's id (a log line, "who owns @bot:server.tld", a quoted reply) and would
 * mistakenly activate a thread.
 */
function bodyMentionsUser(content, ownUserId) {
  if (!ownUserId) return false;
  const rawBody = typeof content.body === 'string' ? content.body : '';
  const rawFormattedBody = typeof content.formatted_body === 'string' ? content.formatted_body : '';
  if (!rawBody && !rawFormattedBody) return false;
  const body = stripReplyFallback(rawBody);
  const formattedBody = stripFormattedReplyFallback(rawFormattedBody);
  const pill = `https://matrix.to/#/${ownUserId}`;
  return body.includes(pill) || formattedBody.includes(pill);
}

/** msgtypes that carry a downloadable attachment. */
const MEDIA_MSGTYPES = new Set(['m.image', 'm.file', 'm.video', 'm.audio']);

/**
 * Extract attachment metadata from a media message event. A Matrix event
 * carries at most one attachment (unlike Slack's files[] array), so this
 * always returns 0 or 1 entries.
 */
function extractFiles(ev, content) {
  if (!MEDIA_MSGTYPES.has(content.msgtype)) return [];
  if (typeof content.url !== 'string' || !content.url.startsWith('mxc://')) return [];
  const info = content.info && typeof content.info === 'object' ? content.info : {};
  return [{
    event_id: ev.event_id,
    url: content.url,
    name: typeof content.body === 'string' ? content.body : undefined,
    mimetype: typeof info.mimetype === 'string' ? info.mimetype : undefined,
    size: typeof info.size === 'number' ? info.size : undefined,
  }];
}

/**
 * Decide whether a Matrix timeline event should trigger onMessage.
 *
 * @param ev              - A room timeline event, with `room_id` attached by the
 *                          caller (raw /sync events are keyed by room, not
 *                          self-labeled). Any shape, may be partial.
 * @param ownUserId       - The bot's own mxid (e.g. "@bot:server.tld"), or null
 *                          if not yet known.
 * @param roomId          - Room filter (string) or null/undefined for any room.
 * @param activatedThreads - Mutable ActivatedThreads instance (mutated on mention)
 * @returns {{ trigger: boolean, text: string, files: object[] }} — trigger: whether
 *          to fire onMessage; text: the raw content.body string; files: attachment
 *          metadata extracted from a media message (empty when none/text-only).
 */
function shouldTrigger(ev, ownUserId, roomId, activatedThreads) {
  if (!ev) return { trigger: false, text: '', files: [] };

  // Room filter
  const roomOk = !roomId || ev.room_id === roomId;
  if (!roomOk) return { trigger: false, text: '', files: [] };

  // ECHO SUPPRESSION — the bot sees its own sends come back through /sync.
  // This MUST be checked before any mention/thread logic, or a self-mention
  // (e.g. quoting itself in a thread) would trigger an infinite reply loop.
  if (ev.sender === ownUserId) {
    return { trigger: false, text: '', files: [] };
  }

  // Only room messages are eligible. State events (m.room.member), reactions
  // (m.reaction), redactions, etc. never trigger.
  if (ev.type !== 'm.room.message') return { trigger: false, text: '', files: [] };

  const content = ev.content && typeof ev.content === 'object' ? ev.content : {};
  const relatesTo = content['m.relates_to'] && typeof content['m.relates_to'] === 'object'
    ? content['m.relates_to']
    : null;

  // Edits (m.replace) must never (re)trigger — the Matrix analogue of Slack's
  // message_changed subtype exclusion.
  if (relatesTo && relatesTo.rel_type === 'm.replace') {
    return { trigger: false, text: '', files: [] };
  }

  const text = typeof content.body === 'string' ? content.body : '';

  // Is this an @-mention of the bot?
  const mentions = content['m.mentions'];
  const mentionIds = mentions && Array.isArray(mentions.user_ids) ? mentions.user_ids : [];
  const isMention =
    (ownUserId != null && mentionIds.includes(ownUserId)) ||
    bodyMentionsUser(content, ownUserId);

  // Is this a reply inside a thread where the bot was already mentioned?
  const isThreadReply = !!(relatesTo && relatesTo.rel_type === 'm.thread' && relatesTo.event_id);
  const isActivatedThread = isThreadReply && activatedThreads.has(relatesTo.event_id);

  if (!isMention && !isActivatedThread) return { trigger: false, text: '', files: [] };

  // On mention: activate the thread so future replies in it also trigger.
  // Use the thread root if the mention is itself a threaded reply, else the
  // message's own event_id becomes the root.
  if (isMention) {
    const threadRoot = isThreadReply ? relatesTo.event_id : ev.event_id;
    if (threadRoot) activatedThreads.add(threadRoot);
  }

  const files = extractFiles(ev, content);

  return { trigger: true, text, files };
}

module.exports = {
  shouldTrigger,
  ActivatedThreads,
  SeenEvents,
  dedupKey,
  ACTIVATED_THREADS_MAX,
  SEEN_EVENTS_MAX,
};
