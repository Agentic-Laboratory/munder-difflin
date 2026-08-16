/**
 * MatrixClient — receive Matrix messages and hand them to the harness.
 *
 * The Matrix counterpart to src/main/slack.ts. It mirrors that module's SHAPE
 * (lifecycle, reconnect/backoff, trigger delegation, loud-failure logging) but
 * NOT its transport mechanics: Slack Socket Mode / Events API has no Matrix
 * analogue. Matrix inbound is a long-poll of the client-server `/sync` endpoint
 * against a SELF-HOSTED homeserver, authenticated with a plain access token:
 *   - `GET /_matrix/client/v3/account/whoami` once, to learn our own user id
 *     (required for echo suppression — the bot sees its own sends in `/sync`),
 *   - `GET /_matrix/client/v3/sync?since=<next_batch>&timeout=30000` in a loop,
 *   - `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}` to reply.
 *
 * Runs in the Electron main process. Deliberately free of any `electron` import,
 * and `fetch` is injected as a constructor dependency, so the whole transport is
 * unit-testable under plain node without a live homeserver — the same seam
 * src/main/integrationBroker.ts uses for `getRecord` / `getSecret`.
 *
 * ── FIVE FAILURE MODES THIS MODULE EXISTS TO PREVENT ────────────────────────
 *
 * 1. E2EE IS THE SHOWSTOPPER. A plain `/sync` bot CANNOT read end-to-end
 *    encrypted rooms — their messages arrive as opaque `m.room.encrypted`
 *    events and decrypting them needs a megolm stack, which is OUT OF SCOPE.
 *    Synapse/Element encrypt private rooms BY DEFAULT, so this is the likely
 *    case, not the exotic one. The failure to avoid is a bot that connects
 *    perfectly, reports healthy, and silently sees nothing. So encryption is
 *    detected THREE ways and always fails LOUDLY (see `isRoomEncrypted`).
 * 2. `next_batch` IS PERSISTED (injected `SyncTokenStore`). Drop it and every
 *    restart either re-processes or skips events. Slack has no analogue.
 * 3. The FIRST `/sync` (no `since=`) returns a full backlog snapshot. We take
 *    its `next_batch` and DISCARD its events — the bot must never fire on room
 *    history it is only now seeing for the first time.
 * 4. ECHO SUPPRESSION: events where `sender === ownUserId` are dropped, or the
 *    bot replies to itself forever.
 * 5. `/sync` with `timeout=` RETURNS EMPTY AS ITS NORMAL IDLE BEHAVIOUR and must
 *    be re-issued immediately. Backoff applies ONLY to errors — never to a
 *    normal empty return, which would throttle the bot into uselessness.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Trigger logic (owned by src/main/matrix-trigger.cjs, another card) ───────
// Loaded lazily and injectable, unlike slack.ts's eager top-level require: this
// module must stay loadable (and unit-testable) whether or not the trigger card
// has landed yet. Same `require(...) as {...}` shape as slack.ts otherwise.

/** Bounded FIFO set of thread roots where the bot was mentioned. */
export interface IActivatedThreads {
  add(threadRootId: string): void;
  has(threadRootId: string): boolean;
  readonly size: number;
}

/** Bounded FIFO idempotency cache, keyed by Matrix `event_id`. */
export interface ISeenEvents {
  seen(key: string): boolean;
  readonly size: number;
}

/** What `shouldTrigger` hands back. `threadRootId` is optional — when the trigger
 *  module omits it we fall back to reading `m.relates_to` ourselves. */
export interface MatrixTriggerResult {
  trigger: boolean;
  text: string;
  threadRootId?: string;
}

/**
 * The contract this module codes against for `./matrix-trigger.cjs`, mirroring
 * `slack-trigger.cjs`. NOTE for the trigger card: `/sync` timeline events do NOT
 * carry `room_id` — they arrive grouped under `rooms.join[roomId]` — so this
 * module SYNTHESIZES `ev.room_id` before calling, exactly as `ev.channel` works
 * on the Slack side. `ownDisplayName` is a 5th argument (Slack has no analogue);
 * a 4-argument implementation ignores it harmlessly.
 */
export interface MatrixTriggerModule {
  shouldTrigger(
    ev: MatrixTimelineEventView,
    ownUserId: string | null,
    /** F2: a single room id, a set/array of them, or nothing for "any room".
     *  The config field is `matrixRoomIds` (plural), so the filter has to be
     *  plural-capable; the singular string form is still accepted verbatim. */
    roomFilter: MatrixRoomFilter,
    activatedThreads: IActivatedThreads,
    ownDisplayName?: string | null
  ): MatrixTriggerResult;
  ActivatedThreads: new (maxSize?: number) => IActivatedThreads;
  SeenEvents: new (maxSize?: number) => ISeenEvents;
}

/** Every shape the room filter is allowed to take (see MatrixTriggerModule). */
export type MatrixRoomFilter =
  | string
  | readonly string[]
  | ReadonlySet<string>
  | null
  | undefined;

let _triggerModCache: MatrixTriggerModule | null = null;

/** Resolve the trigger module on first use. Throws a self-explanatory error if
 *  the file is absent, rather than failing obscurely deep in the sync loop. */
function loadTriggerModule(): MatrixTriggerModule {
  if (_triggerModCache) return _triggerModCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _triggerModCache = require('./matrix-trigger.cjs') as MatrixTriggerModule;
  } catch (e) {
    throw new Error(
      `matrix: cannot load ./matrix-trigger.cjs (${errMsg(e)}). Pass opts.trigger to ` +
      'MatrixClient to inject an implementation, or ensure the trigger module is built.'
    );
  }
  return _triggerModCache;
}

// ── Injected fetch seam ──────────────────────────────────────────────────────
// Structural types rather than DOM/undici ones: tsconfig.node.json has no "dom"
// lib, and a hand-rolled shape makes test fakes a two-line object literal.

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

/** Node 18+ global fetch, narrowed to the subset this module uses. */
function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new Error('matrix: no global fetch available — inject opts.fetchImpl');
  }
  return f as unknown as FetchLike;
}

// ── next_batch persistence (TRAP 2) ─────────────────────────────────────────

/** Where the `/sync` token survives a restart. Injected so main can back it with
 *  a file under `userData` without this module importing electron. */
export interface SyncTokenStore {
  load(): string | null;
  save(token: string): void;
}

/** In-memory store — the token does NOT survive a restart. Used for tests, and
 *  as the default with a loud warning at `start()` so nobody gets it by accident. */
export function createMemorySyncTokenStore(initial: string | null = null): SyncTokenStore {
  let token = initial;
  return { load: () => token, save: (t) => { token = t; } };
}

/** File-backed store. Writes to `<path>.tmp` then renames, so a crash mid-write
 *  leaves the previous token intact rather than a truncated one. */
export function createFileSyncTokenStore(filePath: string): SyncTokenStore {
  return {
    load(): string | null {
      try {
        const raw = readFileSync(filePath, 'utf8').trim();
        return raw || null;
      } catch { return null; } // absent on first boot — not an error
    },
    save(token: string): void {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, token, 'utf8');
        renameSync(tmp, filePath);
      } catch { /* persistence is best-effort; never kill the sync loop */ }
    }
  };
}

// ── Public message shape ────────────────────────────────────────────────────

/** A normalized, echo-filtered, deduped inbound Matrix message plus the
 *  coordinates needed to reply in-thread. Parallel to `SlackInboundMessage`:
 *  `roomId` ≈ channel, `eventId` ≈ ts, `threadRootId` ≈ thread_ts. */
export interface MatrixInboundMessage {
  text: string;
  roomId: string;
  eventId: string;
  sender: string;
  /** `m.relates_to` thread root when the message is a thread reply, else the
   *  message's own `event_id` — so replies nest under the request. */
  threadRootId: string;
  /** `origin_server_ts` in ms, or 0 when the homeserver omitted it. */
  ts: number;
}

export interface MatrixClientOptions {
  /** Self-hosted homeserver base URL, e.g. `https://matrix.example.org`. */
  homeserverUrl: string;
  /** Bot access token. NEVER logged, never returned in an error. */
  accessToken: string;
  /** Optional room filter — when set, events from other rooms are dropped and
   *  the room is encryption-checked up front so `start()` can refuse loudly.
   *  Kept for callers (and tests) that only ever watch one room; `roomIds` is
   *  the general form and the two are unioned. */
  roomId?: string;
  /** F2: the plural room filter, matching config `matrixRoomIds`. Empty (or
   *  absent, with no `roomId`) means "every room the bot is joined to". Each
   *  entry gets the same membership + encryption preflight as the singular
   *  form, and ANY unreadable configured room fails `start()` — same
   *  fail-closed rule M2 chose for one room, applied to the list. */
  roomIds?: readonly string[];
  /** Called once per accepted message. May be async. */
  onMessage?: (m: MatrixInboundMessage) => void | Promise<void>;
  /** Fired on a fatal transport condition (bad token, target room encrypted). */
  onError?: (error: string) => void;
  /** Injected fetch — the unit-test seam. Defaults to the global. */
  fetchImpl?: FetchLike;
  /** Where `next_batch` is persisted. Defaults to memory + a loud warning. */
  syncTokenStore?: SyncTokenStore;
  /** Injected trigger module. Defaults to a lazy `require('./matrix-trigger.cjs')`. */
  trigger?: MatrixTriggerModule;
  /** `/sync` long-poll timeout in ms. */
  syncTimeoutMs?: number;
  /** Structured log sink. Defaults to console with a `[matrix]` prefix. */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** A `/sync` timeline event with `room_id` synthesized by this module (see
 *  `MatrixTriggerModule`) so the trigger layer can filter on it like Slack's
 *  `ev.channel`. */
export interface MatrixTimelineEventView extends MatrixEvent {
  room_id: string;
}

/** Health snapshot. `healthy: false` is the whole point — a bot that connects
 *  cleanly but can read nothing must NOT look fine (TRAP 1). */
export interface MatrixStatus {
  running: boolean;
  healthy: boolean;
  userId: string | null;
  displayName: string | null;
  /** Completed `/sync` round trips since `start()`. */
  syncCount: number;
  /** Joined rooms seen at least once in `/sync`. */
  visibleRooms: number;
  /** Joined rooms known to be UNencrypted, i.e. actually readable. */
  readableRooms: number;
  /** Joined rooms proven end-to-end encrypted — unreadable without megolm. */
  encryptedRooms: string[];
  messagesEmitted: number;
  lastError: string | null;
  /** Set when the loop stopped for a condition retrying cannot fix. */
  fatalError: string | null;
}

/** Outcome of the per-room `m.room.encryption` state probe. `forbidden` is kept
 *  distinct from `unknown` because it means "cannot read this room at all". */
type RoomProbe = 'encrypted' | 'plaintext' | 'forbidden' | 'unknown';

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
/** Error backoff: exponential from 1s to 60s, jittered. NEVER applied to a
 *  normal empty `/sync` return (TRAP 5). */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** Cap on how long a single `/sync` may hang before we abandon it: the server
 *  timeout plus slack for a slow network. */
const SYNC_ABORT_GRACE_MS = 15_000;
/** Guard the one-shot per-room encryption probe against a wedged homeserver. */
const STATE_PROBE_TIMEOUT_MS = 15_000;

export class MatrixClient {
  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  /** The configured rooms, in order, deduped and blank-stripped. Empty = watch
   *  every joined room. */
  private readonly configuredRooms: readonly string[];
  /** The same list as a lookup Set, or null when nothing is configured. This is
   *  the single value handed to both the `/sync` room filter and the trigger
   *  module, so the two can never disagree (F2). */
  private readonly roomFilter: ReadonlySet<string> | null;
  private readonly fetchImpl: FetchLike;
  private readonly store: SyncTokenStore;
  private readonly syncTimeoutMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly onError?: (error: string) => void;
  private readonly triggerOverride?: MatrixTriggerModule;
  private triggerMod: MatrixTriggerModule | null = null;
  private readonly listeners: ((m: MatrixInboundMessage) => void | Promise<void>)[] = [];

  private running = false;
  private loop: Promise<void> | null = null;
  private inflight: AbortController | null = null;
  private wakeSleep: (() => void) | null = null;
  private backoffMs = 0;
  /** Set by a 429 so the error path sleeps the server's `retry_after_ms` once,
   *  instead of that value AND an escalating backoff. */
  private retryAfterOverrideMs: number | null = null;

  /** Our own user id — echo suppression (TRAP 4) is impossible without it. */
  private ownUserId: string | null = null;
  private ownDisplayName: string | null = null;
  private nextBatch: string | null = null;

  private activatedThreads: IActivatedThreads | null = null;
  private seenEvents: ISeenEvents | null = null;

  /** Rooms proven encrypted → skipped, warned about once. */
  private readonly encryptedRooms = new Set<string>();
  /** Rooms whose definitive state probe came back "not encrypted". */
  private readonly plaintextRooms = new Set<string>();
  private readonly seenRooms = new Set<string>();
  /** Rooms already warned about, so the loud warning isn't logged every sync. */
  private readonly warnedRooms = new Set<string>();

  private syncCount = 0;
  private messagesEmitted = 0;
  private lastError: string | null = null;
  private fatalError: string | null = null;

  constructor(opts: MatrixClientOptions) {
    this.homeserverUrl = opts.homeserverUrl.replace(/\/+$/, '');
    this.accessToken = opts.accessToken;
    // Union the singular and plural forms so either spelling works and both
    // together are not a conflict (F2).
    const rooms = [...(opts.roomIds ?? []), ...(opts.roomId ? [opts.roomId] : [])]
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.trim())
      .filter(Boolean);
    this.configuredRooms = [...new Set(rooms)];
    this.roomFilter = this.configuredRooms.length > 0 ? new Set(this.configuredRooms) : null;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch();
    this.store = opts.syncTokenStore ?? createMemorySyncTokenStore();
    this.syncTimeoutMs = opts.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.onError = opts.onError;
    this.triggerOverride = opts.trigger;
    this.log = opts.logger ?? ((level, message) => {
      const line = `[matrix] ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    });
    if (opts.onMessage) this.listeners.push(opts.onMessage);
    // Persistence is opt-IN via injection, so say so rather than letting a
    // caller discover on their second boot that events replay (TRAP 2).
    if (!opts.syncTokenStore) {
      this.log('warn', 'no syncTokenStore injected — next_batch is in-memory only and will ' +
        'NOT survive a restart; pass createFileSyncTokenStore(path) in production');
    }
  }

  /** Register an additional inbound-message listener. Returns an unsubscribe fn. */
  onMessage(cb: (m: MatrixInboundMessage) => void | Promise<void>): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Authenticate, refuse loudly if the configured room is unreadable, then start
   * the `/sync` long-poll loop in the background.
   *
   * Resolves only after the identity + encryption preflight, so a caller that
   * gets `{ ok: true }` really does have a bot that can see messages — the
   * whole point of TRAP 1. The loop itself is NOT awaited.
   */
  async start(): Promise<{ ok: boolean; userId?: string; error?: string }> {
    if (this.running) return { ok: false, error: 'already running' };
    if (!this.homeserverUrl) return { ok: false, error: 'missing homeserver url' };
    if (!this.accessToken) return { ok: false, error: 'missing access token' };

    let mod: MatrixTriggerModule;
    try {
      mod = this.triggerOverride ?? loadTriggerModule();
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
    this.triggerMod = mod;
    this.activatedThreads = new mod.ActivatedThreads();
    this.seenEvents = new mod.SeenEvents();

    // 1) Who are we? Without this there is no echo suppression, so a failure
    //    here is fatal rather than something to retry into a reply loop.
    const who = await this.whoami();
    if (!who.ok) return { ok: false, error: `whoami failed: ${who.error}` };
    this.ownUserId = who.userId ?? null;
    if (!this.ownUserId) return { ok: false, error: 'whoami returned no user_id' };

    // 2) Display name, for the older-client mention form (a matrix.to pill or a
    //    bare display name in the body). Best-effort — mentions still work via
    //    `m.mentions.user_ids` without it.
    this.ownDisplayName = await this.fetchDisplayName(this.ownUserId);

    // 3) TRAP 1 preflight, run over EVERY configured room. If we were pointed at
    //    a room that is unreadable — we're not in it, or it's encrypted — this
    //    bot can never work there. Say so now, at start, instead of reporting
    //    healthy forever while seeing nothing. Membership is checked first
    //    because "not joined" has a clearer fix than "encrypted", and because an
    //    unjoined room's state read would otherwise 403 and look merely
    //    undetermined.
    //
    //    FAIL-CLOSED ON ANY ONE ROOM (F2 decision): with a list, a single bad
    //    entry could plausibly be dropped so the others proceed. It is not.
    //    M2 chose to refuse start() for one unreadable room precisely so a
    //    misconfiguration is loud, and silently listening on 2 of 3 configured
    //    rooms is the same silent-partial-failure it was written to prevent.
    for (const room of this.configuredRooms) {
      const member = await this.isJoinedTo(room);
      if (member === false) {
        return this.failPreflight(
          `the bot is NOT JOINED to room ${room} (checked via /joined_rooms), so /sync ` +
          'will never deliver a message from it. Invite the bot and accept the invite — this ' +
          'client does not auto-join. Check the room id for typos too.'
        );
      }
      if (member === null) {
        this.log('warn', `could not verify membership of ${room} via /joined_rooms — proceeding`);
      }

      const probe = await this.probeRoomEncryption(room);
      if (probe === 'encrypted') {
        return this.failPreflight(
          `room ${room} is END-TO-END ENCRYPTED. This client reads plaintext ` +
          '`m.room.message` events only and has no megolm/olm stack, so it would connect ' +
          'successfully and never see a single message. Disable encryption for this room, ' +
          'or point the bot at an unencrypted room.'
        );
      }
      if (probe === 'forbidden') {
        // Same failure class as encryption: the bot would sync forever and see
        // nothing, because it cannot read this room at all.
        return this.failPreflight(
          `room ${room} is NOT READABLE by this bot (403 M_FORBIDDEN) — it is almost ` +
          'certainly not joined to the room, or the room id is wrong. Invite and join the bot ' +
          'first; syncing would otherwise report healthy while seeing nothing.'
        );
      }
      if (probe === 'plaintext') this.plaintextRooms.add(room);
      else {
        this.log('warn', `could not determine encryption state of ${room} — ` +
          'proceeding, but m.room.encrypted events will be treated as proof of encryption');
      }
    }

    // 4) Resume from the persisted token (TRAP 2), or take a backlog-discarding
    //    initial snapshot (TRAP 3).
    this.nextBatch = this.store.load();
    if (this.nextBatch) {
      this.log('info', `resuming /sync from persisted next_batch (…${this.nextBatch.slice(-8)})`);
    } else {
      const primed = await this.primeSyncToken();
      if (!primed.ok) return { ok: false, error: `initial /sync failed: ${primed.error}` };
      this.log('info', 'initial /sync snapshot taken; room history discarded, not replayed');
    }

    this.running = true;
    this.fatalError = null;
    this.loop = this.runSyncLoop();
    const where = this.configuredRooms.length > 0
      ? ` (room${this.configuredRooms.length > 1 ? 's' : ''} ${this.configuredRooms.join(', ')})`
      : ' (all joined rooms)';
    this.log('info', `connected as ${this.ownUserId}${where}`);
    return { ok: true, userId: this.ownUserId };
  }

  /** Record a preflight verdict that makes this bot permanently blind, tell
   *  whoever is listening, and hand the caller the same message. */
  private failPreflight(msg: string): { ok: false; error: string } {
    this.fatalError = msg;
    this.log('error', msg);
    this.onError?.(msg);
    return { ok: false, error: msg };
  }

  /** Stop the loop. Idempotent and best-effort; aborts any in-flight long poll. */
  stop(): void {
    this.running = false;
    try { this.inflight?.abort(); } catch { /* noop */ }
    this.inflight = null;
    const wake = this.wakeSleep;
    this.wakeSleep = null;
    try { wake?.(); } catch { /* noop */ }
    this.loop = null;
  }

  /** Health snapshot — see `MatrixStatus`. */
  getStatus(): MatrixStatus {
    const readableRooms = [...this.seenRooms].filter((r) => !this.encryptedRooms.has(r)).length;
    // A bot that is up, joined to rooms, and can read NONE of them is the exact
    // silent failure TRAP 1 describes. Report it as unhealthy.
    const blind = this.seenRooms.size > 0 && readableRooms === 0;
    // NOTE: "the configured room never appears in /sync" is NOT usable as a
    // health signal — an INCREMENTAL sync omits rooms with no activity, so a
    // simply-quiet room looks identical to a missing one. Membership is settled
    // definitively at start() via /joined_rooms instead.
    return {
      running: this.running,
      healthy: this.running && !this.fatalError && this.ownUserId !== null && !blind,
      userId: this.ownUserId,
      displayName: this.ownDisplayName,
      syncCount: this.syncCount,
      visibleRooms: this.seenRooms.size,
      readableRooms,
      encryptedRooms: [...this.encryptedRooms],
      messagesEmitted: this.messagesEmitted,
      lastError: this.lastError,
      fatalError: this.fatalError
    };
  }

  /** Send `text` into `roomId` using this client's credentials. */
  sendMessage(
    roomId: string,
    text: string,
    opts?: { threadRootId?: string; replyToEventId?: string }
  ): Promise<MatrixSendResult> {
    return sendMatrixMessage({
      homeserverUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      roomId,
      text,
      threadRootId: opts?.threadRootId,
      replyToEventId: opts?.replyToEventId,
      fetchImpl: this.fetchImpl
    });
  }

  // ── transport internals ───────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' };
  }

  private async whoami(): Promise<{ ok: boolean; userId?: string; error?: string }> {
    try {
      const res = await this.fetchImpl(
        `${this.homeserverUrl}/_matrix/client/v3/account/whoami`,
        { method: 'GET', headers: this.authHeaders() }
      );
      if (!res.ok) return { ok: false, error: await describeError(res) };
      const body = (await res.json()) as { user_id?: unknown };
      const userId = typeof body?.user_id === 'string' ? body.user_id : undefined;
      return userId ? { ok: true, userId } : { ok: false, error: 'no user_id in response' };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  /**
   * Definitive membership check via `GET /_matrix/client/v3/joined_rooms`.
   *
   * @returns true = joined, false = definitively NOT joined, null = the call
   *          itself failed (don't guess — a network blip is not evidence).
   */
  private async isJoinedTo(roomId: string): Promise<boolean | null> {
    try {
      const res = await this.fetchImpl(
        `${this.homeserverUrl}/_matrix/client/v3/joined_rooms`,
        { method: 'GET', headers: this.authHeaders() }
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { joined_rooms?: unknown };
      if (!Array.isArray(body?.joined_rooms)) return null;
      return body.joined_rooms.includes(roomId);
    } catch { return null; }
  }

  /** Best-effort profile lookup; a missing display name is not an error. */
  private async fetchDisplayName(userId: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(
        `${this.homeserverUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
        { method: 'GET', headers: this.authHeaders() }
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { displayname?: unknown };
      return typeof body?.displayname === 'string' && body.displayname ? body.displayname : null;
    } catch { return null; }
  }

  /**
   * Definitive per-room encryption answer: `GET .../state/m.room.encryption`
   * returns 200 when the room is encrypted and 404 (`M_NOT_FOUND`) when it is not.
   *
   * This is the PRIMARY check because it is independent of `/sync` deltas. An
   * INCREMENTAL sync only carries state that CHANGED since `since=`, so a room
   * encrypted before our persisted `next_batch` would never re-emit its
   * `m.room.encryption` event — after the first restart it would look plaintext.
   * That is the exact interaction between TRAP 1 and TRAP 2 this probe closes.
   *
   * `forbidden` (403 `M_FORBIDDEN`) is broken out from the generic `unknown`
   * because it almost always means the bot is NOT JOINED to the room — a typo'd
   * room id, or an invite nobody accepted. Swallowing that as "undetermined"
   * would let a bot that can never see the room report itself healthy, which is
   * the same silent failure E2EE causes.
   *
   * `unknown` is deliberately NOT cached, so the next sighting retries.
   */
  private async probeRoomEncryption(roomId: string): Promise<RoomProbe> {
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* noop */ } }, STATE_PROBE_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(
        `${this.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
        { method: 'GET', headers: this.authHeaders(), signal: ac.signal }
      );
      if (res.ok) return 'encrypted';
      if (res.status === 404) return 'plaintext'; // M_NOT_FOUND: no encryption state
      if (res.status === 403) return 'forbidden'; // not joined / not permitted to read state
      return 'unknown';
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * TRAP 3. The first `/sync` with no `since=` returns a full snapshot of room
   * history. Take its `next_batch` and throw the events away — firing on
   * backlog would spam every thread the bot can see the moment it boots.
   */
  private async primeSyncToken(): Promise<{ ok: boolean; error?: string }> {
    // timeout=0 returns immediately; the tiny timeline limit keeps the snapshot
    // small. The discard below — not this filter — is what guarantees no replay.
    const filter = encodeURIComponent(JSON.stringify({
      room: { timeline: { limit: 1 }, state: { lazy_load_members: true } },
      presence: { types: [] }
    }));
    try {
      const res = await this.fetchImpl(
        `${this.homeserverUrl}/_matrix/client/v3/sync?timeout=0&filter=${filter}`,
        { method: 'GET', headers: this.authHeaders() }
      );
      if (!res.ok) return { ok: false, error: await describeError(res) };
      const body = (await res.json()) as MatrixSyncResponse;
      if (typeof body?.next_batch !== 'string' || !body.next_batch) {
        return { ok: false, error: 'no next_batch in initial sync' };
      }
      // Record which rooms exist (for status) but process NO timeline events.
      for (const roomId of Object.keys(body.rooms?.join ?? {})) this.seenRooms.add(roomId);
      this.nextBatch = body.next_batch;
      this.store.save(body.next_batch);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  /**
   * The long-poll loop. A normal `/sync` return — including an EMPTY one, which
   * is what an idle room looks like — resets the backoff and re-issues
   * immediately (TRAP 5). Only errors back off.
   */
  private async runSyncLoop(): Promise<void> {
    while (this.running) {
      let body: MatrixSyncResponse | null = null;
      try {
        body = await this.syncOnce();
      } catch (e) {
        if (!this.running) break; // stop() aborted the in-flight request
        const message = errMsg(e);
        this.lastError = message;
        // A 429 carries an explicit wait from the server — honour it verbatim
        // instead of our own guess, and don't escalate the backoff for it.
        const override = this.retryAfterOverrideMs;
        this.retryAfterOverrideMs = null;
        const delay = override ?? this.nextBackoffMs();
        this.log('warn', `/sync failed (${message}); retrying in ${Math.round(delay / 1000)}s`);
        await this.sleep(delay);
        continue;
      }
      if (!this.running) break;
      if (body === null) continue; // fatal — runSyncLoop already stopped

      this.syncCount += 1;
      this.lastError = null;
      this.backoffMs = 0; // SUCCESS, empty or not — never throttle an idle room

      try {
        await this.processSync(body);
      } catch (e) {
        // A bad event must not kill the transport.
        this.log('warn', `error processing sync batch: ${errMsg(e)}`);
      }

      // TRAP 2 + at-least-once delivery: persist AFTER dispatch. Saving first
      // would silently DROP a batch on a crash mid-dispatch; saving after can at
      // worst re-deliver one batch, which the event_id dedup cache absorbs.
      // (That cache is in-memory, so a crash can re-deliver one batch after a
      // restart — the accepted tradeoff. Do not build persistent dedup for it.)
      if (typeof body.next_batch === 'string' && body.next_batch) {
        this.nextBatch = body.next_batch;
        this.store.save(body.next_batch);
      }
    }
  }

  /** One `/sync` round trip. Returns null after a fatal condition (loop stopped). */
  private async syncOnce(): Promise<MatrixSyncResponse | null> {
    const ac = new AbortController();
    this.inflight = ac;
    const timer = setTimeout(
      () => { try { ac.abort(); } catch { /* noop */ } },
      this.syncTimeoutMs + SYNC_ABORT_GRACE_MS
    );
    try {
      const params = new URLSearchParams({ timeout: String(this.syncTimeoutMs) });
      if (this.nextBatch) params.set('since', this.nextBatch);
      const res = await this.fetchImpl(
        `${this.homeserverUrl}/_matrix/client/v3/sync?${params.toString()}`,
        { method: 'GET', headers: this.authHeaders(), signal: ac.signal }
      );
      if (res.status === 401) {
        // Retrying an invalid/expired token forever is a silent outage.
        const msg = 'access token rejected by the homeserver (401) — the bot is offline ' +
          'until a valid token is supplied';
        this.fail(msg);
        return null;
      }
      if (res.status === 429) {
        // Hand the server's own retry_after_ms to the error path and let THAT
        // do the single sleep. Sleeping here as well would wait twice and also
        // escalate the exponential backoff on top of an explicit instruction.
        this.retryAfterOverrideMs = await retryAfterMs(res);
        throw new Error(`rate limited (429), retry after ${this.retryAfterOverrideMs}ms`);
      }
      if (!res.ok) throw new Error(await describeError(res));
      return (await res.json()) as MatrixSyncResponse;
    } finally {
      clearTimeout(timer);
      if (this.inflight === ac) this.inflight = null;
    }
  }

  /** Walk the joined rooms of one `/sync` batch and dispatch eligible messages. */
  private async processSync(body: MatrixSyncResponse): Promise<void> {
    const joined = body.rooms?.join ?? {};
    for (const [roomId, room] of Object.entries(joined)) {
      if (!this.running) return;
      if (this.roomFilter && !this.roomFilter.has(roomId)) continue;
      this.seenRooms.add(roomId);

      const timeline = room?.timeline?.events ?? [];
      const state = room?.state?.events ?? [];

      // TRAP 1, detection #2: an explicit m.room.encryption state event.
      if ([...state, ...timeline].some((ev) => ev?.type === 'm.room.encryption')) {
        this.markEncrypted(roomId, 'an m.room.encryption state event');
      }
      // TRAP 1, detection #3: messages arriving as opaque m.room.encrypted. This
      // is the in-band signal that survives incremental sync when the room was
      // encrypted before our persisted next_batch, so #2 never fires again.
      if (timeline.some((ev) => ev?.type === 'm.room.encrypted')) {
        this.markEncrypted(roomId, 'opaque m.room.encrypted events on the timeline');
      }
      if (this.encryptedRooms.has(roomId)) continue;

      // TRAP 1, detection #1 (definitive): probe unseen rooms once. Cached, and
      // an undetermined answer is retried on the next sighting.
      if (!this.plaintextRooms.has(roomId)) {
        const probe = await this.probeRoomEncryption(roomId);
        if (probe === 'encrypted') { this.markEncrypted(roomId, 'the m.room.encryption state endpoint'); continue; }
        if (probe === 'plaintext') this.plaintextRooms.add(roomId);
        // 'forbidden'/'unknown' are not cached — retry on the next sighting, and
        // rely on m.room.encrypted as the in-band fallback.
      }

      for (const ev of timeline) {
        if (!this.running) return;
        await this.handleEvent(roomId, ev);
      }
    }
  }

  /** Record a room as unreadable and say so once, loudly. */
  private markEncrypted(roomId: string, evidence: string): void {
    this.encryptedRooms.add(roomId);
    this.plaintextRooms.delete(roomId);
    if (this.warnedRooms.has(roomId)) return;
    this.warnedRooms.add(roomId);
    const msg =
      `room ${roomId} is END-TO-END ENCRYPTED (detected via ${evidence}). This client has no ` +
      'megolm/olm stack, so its messages are UNREADABLE and are being skipped — the bot will ' +
      'never respond in this room. Disable encryption for it or use an unencrypted room.';
    this.log('error', msg);
    this.lastError = msg;
    this.onError?.(msg);
    // Was this room explicitly configured? Then part of what the operator asked
    // for can never work — go fatal rather than quietly serving the remainder.
    if (this.roomFilter?.has(roomId)) this.fail(msg);
  }

  /** Normalize one timeline event and, if the trigger layer says so, emit it. */
  private async handleEvent(roomId: string, raw: MatrixEvent | undefined): Promise<void> {
    if (!raw || raw.type !== 'm.room.message') return; // state/redaction/reaction noise
    const sender = typeof raw.sender === 'string' ? raw.sender : '';
    const eventId = typeof raw.event_id === 'string' ? raw.event_id : '';
    if (!sender || !eventId) return;

    // TRAP 4 — echo suppression. Without this the bot answers itself forever.
    if (this.ownUserId && sender === this.ownUserId) return;

    // An edit re-sends the whole body under m.replace; treating it as a new
    // message would double-fire on text the bot already answered.
    const rel = raw.content?.['m.relates_to'];
    if (rel?.rel_type === 'm.replace') return;

    const ev: MatrixTimelineEventView = { ...raw, room_id: roomId };
    const mod = this.triggerMod;
    const threads = this.activatedThreads;
    if (!mod || !threads) return; // not started

    let verdict: MatrixTriggerResult;
    try {
      verdict = mod.shouldTrigger(ev, this.ownUserId, this.roomFilter, threads, this.ownDisplayName);
    } catch (e) {
      this.log('warn', `shouldTrigger threw for ${eventId}: ${errMsg(e)}`);
      return;
    }
    if (!verdict?.trigger) return;

    const text = typeof verdict.text === 'string' ? verdict.text : '';
    if (!text.trim()) return;

    // event_id is a clean idempotency key — unlike Slack's dual-subscription
    // dedup, Matrix gives one stable id per event.
    if (this.seenEvents?.seen(eventId)) return;

    const threadRootId =
      (typeof verdict.threadRootId === 'string' && verdict.threadRootId) || threadRootOf(ev);

    const msg: MatrixInboundMessage = {
      text,
      roomId,
      eventId,
      sender,
      threadRootId,
      ts: typeof raw.origin_server_ts === 'number' ? raw.origin_server_ts : 0
    };
    this.messagesEmitted += 1;
    for (const cb of [...this.listeners]) {
      try { await cb(msg); } catch { /* delivery is best-effort, mirroring slack.ts */ }
    }
  }

  /** Stop for a condition retrying cannot fix, and make sure someone hears it. */
  private fail(message: string): void {
    this.fatalError = message;
    this.lastError = message;
    this.log('error', message);
    this.onError?.(message);
    this.stop();
  }

  /** Exponential backoff with 50–100% jitter, so N clients don't sync in lockstep. */
  private nextBackoffMs(): number {
    this.backoffMs = this.backoffMs === 0
      ? INITIAL_BACKOFF_MS
      : Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    return Math.round(this.backoffMs * (0.5 + Math.random() * 0.5));
  }

  /** Sleep that `stop()` can cut short, so shutdown isn't stuck behind a backoff. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wakeSleep = null; resolve(); }, ms);
      this.wakeSleep = () => { clearTimeout(timer); resolve(); };
    });
  }
}

// ── Outbound ────────────────────────────────────────────────────────────────

export interface MatrixSendResult {
  ok: boolean;
  eventId?: string;
  error?: string;
}

export interface SendMatrixMessageOptions {
  homeserverUrl: string;
  accessToken: string;
  roomId: string;
  text: string;
  /** Root of the thread to reply into — the Matrix analogue of `thread_ts`. */
  threadRootId?: string;
  /** Specific event being replied to; defaults to the thread root. */
  replyToEventId?: string;
  fetchImpl?: FetchLike;
}

/**
 * Post an `m.room.message` via
 * `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`.
 *
 * The transaction id is generated fresh per call and MUST be unique: Matrix
 * treats a repeated txnId as the same send and returns the original event id, so
 * reusing one silently swallows the second message.
 *
 * When `threadRootId` is given the message is a proper `m.thread` reply with the
 * rich-reply fallback set, so it nests in the thread in Element and degrades to a
 * plain reply in clients that don't do threads.
 *
 * The access token is passed in by the caller, never logged and never echoed
 * back in an error — same discipline as `postSlackReply`.
 */
export async function sendMatrixMessage(opts: SendMatrixMessageOptions): Promise<MatrixSendResult> {
  const homeserverUrl = opts.homeserverUrl?.replace(/\/+$/, '') ?? '';
  if (!homeserverUrl) return { ok: false, error: 'missing homeserver url' };
  if (!opts.accessToken) return { ok: false, error: 'missing access token' };
  // Mirrors postSlackReply's CLAUSE-1 guard: refuse a send with no explicit
  // destination rather than guessing one.
  if (!opts.roomId?.trim()) return { ok: false, error: 'missing room id' };
  if (!opts.text?.trim()) return { ok: false, error: 'missing text' };

  const content: Record<string, unknown> = { msgtype: 'm.text', body: opts.text };
  if (opts.threadRootId) {
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: opts.threadRootId,
      // Tells thread-aware clients the m.in_reply_to below is only a fallback
      // for non-threaded clients, not a genuine rich reply.
      is_falling_back: true,
      'm.in_reply_to': { event_id: opts.replyToEventId || opts.threadRootId }
    };
  }

  const txnId = `md-${Date.now()}-${randomUUID()}`;
  const url =
    `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}` +
    `/send/m.room.message/${encodeURIComponent(txnId)}`;

  const doFetch = opts.fetchImpl ?? defaultFetch();
  try {
    const res = await doFetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(content)
    });
    if (!res.ok) return { ok: false, error: await describeError(res) };
    const body = (await res.json()) as { event_id?: unknown };
    return {
      ok: true,
      eventId: typeof body?.event_id === 'string' ? body.event_id : undefined
    };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Alias so callers can import the name the wiring card expects. */
export const sendMessage = sendMatrixMessage;

// ── Preflight: identity + room resolution ───────────────────────────────────
//
// Everything below exists because Settings can only ever hold what a human
// typed, and two of those strings are checked by nobody until the bot is live:
//
//   1. The access token is stored against a `matrixUserId` that nothing has
//      verified it belongs to. `matrix-trigger.cjs` (note 4) suppresses echoes
//      by comparing `sender === ownUserId`, so a token for a DIFFERENT account
//      fails open: the bot answers its own messages forever, unattended.
//   2. `matrixRoomIds` is used raw as an exact-match Set against the `/sync`
//      room keys (see the MatrixClient constructor) — and `/sync` keys are
//      always `!id:server`. A room's display name or alias silently matches
//      nothing, and the bot is deaf with no error anywhere.
//
// So: resolve names/aliases to real ids, and prove membership while doing it —
// a valid token on a room the bot never joined is a 403 at send time, which is
// a much worse place to discover it.

/** The three inputs every authenticated call here needs. */
export interface MatrixApiContext {
  homeserverUrl: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}

type JsonResult = { ok: true; body: unknown } | { ok: false; error: string };

/** Authenticated GET returning parsed JSON. The token goes in the header and is
 *  never logged or echoed into an error — same discipline as sendMatrixMessage. */
async function getJson(ctx: MatrixApiContext, path: string): Promise<JsonResult> {
  const base = ctx.homeserverUrl.replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'missing homeserver url' };
  if (!ctx.accessToken) return { ok: false, error: 'missing access token' };
  const doFetch = ctx.fetchImpl ?? defaultFetch();
  try {
    const res = await doFetch(`${base}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${ctx.accessToken}`, accept: 'application/json' }
    });
    if (!res.ok) return { ok: false, error: await describeError(res) };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/**
 * `GET /_matrix/client/v3/account/whoami` — the account the stored token really
 * belongs to. This is the only way to tell a valid token for the wrong user
 * from a valid token for the right one; both look identical at rest.
 */
export async function matrixWhoami(
  ctx: MatrixApiContext
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const r = await getJson(ctx, '/_matrix/client/v3/account/whoami');
  if (!r.ok) return r;
  const userId = (r.body as { user_id?: unknown })?.user_id;
  if (typeof userId !== 'string' || !userId) return { ok: false, error: 'whoami returned no user_id' };
  return { ok: true, userId };
}

export interface MatrixJoinedRoom {
  roomId: string;
  /** `m.room.name`, or null for an unnamed room. */
  name: string | null;
}

/**
 * The rooms the bot has actually JOINED, with their display names.
 *
 * Membership is half the value: `/joined_rooms` cannot list a room the bot was
 * only invited to, so a hit here proves the send will not 403.
 */
export async function listJoinedRooms(
  ctx: MatrixApiContext
): Promise<{ ok: true; rooms: MatrixJoinedRoom[] } | { ok: false; error: string }> {
  const r = await getJson(ctx, '/_matrix/client/v3/joined_rooms');
  if (!r.ok) return r;
  const ids = (r.body as { joined_rooms?: unknown })?.joined_rooms;
  if (!Array.isArray(ids)) return { ok: false, error: 'joined_rooms returned no room list' };
  const rooms: MatrixJoinedRoom[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue;
    // m.room.name is optional state: a 404 here means "unnamed", not "broken",
    // so a failure downgrades the room to nameless instead of failing the call.
    const nameRes = await getJson(ctx, `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`);
    const raw = nameRes.ok ? (nameRes.body as { name?: unknown })?.name : undefined;
    rooms.push({ roomId: id, name: typeof raw === 'string' && raw.trim() ? raw : null });
  }
  return { ok: true, rooms };
}

export interface MatrixRoomResolution {
  /** Exactly what Settings held, so the UI can name the field the user typed. */
  input: string;
  /** The `!id:server` the listener and the sender can both use, or null. */
  roomId: string | null;
  /** Which form the input turned out to be — for explaining the rewrite. */
  via: 'id' | 'alias' | 'name' | null;
  error: string | null;
}

/** Human-readable label for a joined room, for "did you mean" error text. */
function roomLabel(r: MatrixJoinedRoom): string {
  return r.name ? `${r.name} (${r.roomId})` : r.roomId;
}

/**
 * Turn whatever Settings holds into room ids the `/sync` filter can match.
 *
 * Accepts all three forms a human plausibly types:
 *   `!abc:server`  → verified against joined rooms
 *   `#alias:server` → directory lookup, then verified against joined rooms
 *   `Agent Chat`    → matched against joined rooms by display name
 *
 * An ambiguous name is an error, never a guess: picking one of two rooms named
 * the same thing would post to the wrong one and look like it worked.
 */
export async function resolveMatrixRooms(
  ctx: MatrixApiContext,
  entries: readonly string[]
): Promise<
  { ok: true; joined: MatrixJoinedRoom[]; resolutions: MatrixRoomResolution[] } | { ok: false; error: string }
> {
  const joinedRes = await listJoinedRooms(ctx);
  if (!joinedRes.ok) return joinedRes;
  const joined = joinedRes.rooms;
  const joinedIds = new Set(joined.map((r) => r.roomId));
  const notJoined = (id: string) =>
    `the bot has not joined ${id} — invite it to the room and accept the invite, then test again`;

  const resolutions: MatrixRoomResolution[] = [];
  for (const rawEntry of entries) {
    const input = typeof rawEntry === 'string' ? rawEntry.trim() : '';
    if (!input) continue;

    if (input.startsWith('!')) {
      resolutions.push(
        joinedIds.has(input)
          ? { input, roomId: input, via: 'id', error: null }
          : { input, roomId: null, via: null, error: notJoined(input) }
      );
      continue;
    }

    if (input.startsWith('#')) {
      const r = await getJson(ctx, `/_matrix/client/v3/directory/room/${encodeURIComponent(input)}`);
      if (!r.ok) {
        resolutions.push({ input, roomId: null, via: null, error: `no room found for alias ${input}: ${r.error}` });
        continue;
      }
      const id = (r.body as { room_id?: unknown })?.room_id;
      if (typeof id !== 'string' || !id) {
        resolutions.push({ input, roomId: null, via: null, error: `alias ${input} resolved to no room id` });
        continue;
      }
      resolutions.push(
        joinedIds.has(id)
          ? { input, roomId: id, via: 'alias', error: null }
          : { input, roomId: null, via: null, error: notJoined(id) }
      );
      continue;
    }

    // Neither sigil → treat it as a display name. This is the case that used to
    // fail silently, so the error carries the list of what IS joined.
    const wanted = input.toLowerCase();
    const matches = joined.filter((r) => (r.name ?? '').trim().toLowerCase() === wanted);
    if (matches.length === 1) {
      resolutions.push({ input, roomId: matches[0].roomId, via: 'name', error: null });
    } else if (matches.length === 0) {
      const listed = joined.length ? joined.map(roomLabel).join(', ') : 'no rooms at all';
      resolutions.push({
        input,
        roomId: null,
        via: null,
        error: `no joined room is named "${input}" — the bot has joined: ${listed}`
      });
    } else {
      resolutions.push({
        input,
        roomId: null,
        via: null,
        error: `"${input}" matches ${matches.length} joined rooms — use the room id instead: ${matches
          .map((m) => m.roomId)
          .join(', ')}`
      });
    }
  }

  return { ok: true, joined, resolutions };
}

// ── Wire shapes + helpers ───────────────────────────────────────────────────

/** The subset of a Matrix event this module reads. */
export interface MatrixEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  origin_server_ts?: number;
  state_key?: string;
  content?: {
    body?: string;
    msgtype?: string;
    'm.mentions'?: { user_ids?: string[] };
    'm.relates_to'?: {
      rel_type?: string;
      event_id?: string;
      'm.in_reply_to'?: { event_id?: string };
    };
    'm.new_content'?: { body?: string };
    [key: string]: unknown;
  };
  unsigned?: { transaction_id?: string };
}

/** The subset of the `/sync` response this module reads. */
export interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<string, {
      timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
      state?: { events?: MatrixEvent[] };
    }>;
    /** NOT handled: this client never auto-joins. The bot must already be a
     *  member of the room — invites are ignored. */
    invite?: Record<string, unknown>;
  };
}

/** Thread root for an event: the `m.thread` relation target, else its own id —
 *  so a reply to a non-threaded message starts a thread on that message. */
function threadRootOf(ev: MatrixEvent): string {
  const rel = ev.content?.['m.relates_to'];
  if (rel?.rel_type === 'm.thread' && typeof rel.event_id === 'string' && rel.event_id) {
    return rel.event_id;
  }
  return typeof ev.event_id === 'string' ? ev.event_id : '';
}

/** Turn a non-2xx response into a message including Matrix's `errcode` when the
 *  body carries one. Bounded so a giant HTML error page can't flood the log. */
async function describeError(res: FetchLikeResponse): Promise<string> {
  try {
    const raw = (await res.text()).slice(0, 500);
    try {
      const json = JSON.parse(raw) as { errcode?: string; error?: string };
      if (json?.errcode || json?.error) {
        return `HTTP ${res.status} ${json.errcode ?? ''} ${json.error ?? ''}`.trim();
      }
    } catch { /* not JSON — fall through to the raw snippet */ }
    return raw ? `HTTP ${res.status}: ${raw}` : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Honour a 429's `retry_after_ms`, falling back to the `Retry-After` header. */
async function retryAfterMs(res: FetchLikeResponse): Promise<number> {
  try {
    const raw = await res.text();
    const json = JSON.parse(raw) as { retry_after_ms?: unknown };
    if (typeof json?.retry_after_ms === 'number' && json.retry_after_ms > 0) {
      return Math.min(json.retry_after_ms, MAX_BACKOFF_MS);
    }
  } catch { /* fall through */ }
  const header = res.headers?.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return INITIAL_BACKOFF_MS;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
