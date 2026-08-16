/**
 * Deciding WHEN an agent gets poked about unread hive mail.
 *
 * The inbox-wake nudge is the only thing that tells a freshly spawned worker its
 * objective is waiting. It used to be fire-and-forget: the poll picked the newest
 * inbox id, enqueued one nudge, recorded that id, and never looked again. Two
 * separate faults fell out of that, and together they starved workers silently —
 * the agent booted, was correctly named, showed breaker-green on the floor, and
 * did absolutely nothing until the idle reaper took it 20 minutes later.
 *
 *  1. ONE ATTEMPT, NO RECEIPT. The queue item is dropped the moment the PTY write
 *     resolves, and the recorded id suppresses every later poll. A write that
 *     resolves but is not acted on by the CLI — typed at ~T+3.5s, before the TUI
 *     is reading stdin — is indistinguishable from a delivered one, and there is
 *     no second chance. Delivery is now retried on a bounded backoff for as long
 *     as the SAME mail is still sitting in the inbox, which is the only honest
 *     proof-of-receipt available here: mail an agent has actually read gets moved
 *     to inbox/.done/ and stops being counted.
 *
 *  2. "NEWEST" WAS A STRING SORT. `ids.sort().slice(-1)` assumes every id is the
 *     generated `<ISO>-<rand>` stamp. A hand-authored id does not have to sort
 *     above one: "2026-08-16-nudge-x" < "2026-08-16T18-38-49-200Z-28f64a" because
 *     '-' < 'T'. A follow-up message written that way left `newest` unchanged, so
 *     it produced NO nudge at all — the rescue message for a starved worker could
 *     not itself be delivered. Tracking the id SET instead of a maximum removes
 *     the ordering assumption entirely: mail is fresh when an id is present that
 *     we have not nudged about yet, whatever it is called.
 *
 * Pure and dependency-free on purpose: the message shape is declared inline so
 * this loads under test/load-ts.cjs with no alias resolution, and the caller owns
 * both the polling and the enqueueing.
 */

/** The only field of a hive message this decision needs. */
export interface NudgeableMessage {
  id: string;
}

/** Per-agent bookkeeping the caller carries between polls. */
export interface NudgeState {
  /** The inbox ids this agent has already been nudged about. */
  seen: string[];
  /** Nudges enqueued for the CURRENT undrained mail (1 = the first attempt). */
  attempts: number;
  /** When the last of those was enqueued. */
  lastAt: number;
}

export interface NudgeDecision {
  nudge: boolean;
  /** The state to carry forward; `undefined` once the inbox is empty. */
  state: NudgeState | undefined;
}

/** The wake prompt itself, exported so the caller can also recognise one of its
 *  own nudges still sitting undelivered in the queue. */
export const INBOX_NUDGE_TEXT =
  'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.';

/** Gaps before retry 2, 3 and 4. Deliberately short at the front (a lost first
 *  attempt is almost always a boot race, and a starved worker is burning its idle
 *  cap) and bounded at four attempts inside ~3 minutes, so an agent that simply
 *  hasn't filed its mail yet is poked a handful of times, never in a loop. */
export const NUDGE_RETRY_MS = [15_000, 45_000, 120_000];

/** Total attempts per batch of undrained mail: the first plus one per retry gap. */
export const MAX_NUDGE_ATTEMPTS = NUDGE_RETRY_MS.length + 1;

/** Ids currently sitting in an agent's inbox, de-duplicated and order-independent. */
function idsOf(inbox: readonly NudgeableMessage[]): string[] {
  const out: string[] = [];
  for (const m of inbox) {
    if (m && typeof m.id === 'string' && m.id && !out.includes(m.id)) out.push(m.id);
  }
  return out;
}

/**
 * Should this agent be nudged right now?
 *
 * @param prev    what the last poll left behind for this agent
 * @param inbox   the agent's inbox as read this poll
 * @param now     current time
 * @param pending true when a nudge this loop already enqueued is STILL sitting in
 *                the agent's queue undelivered — the agent is mid-turn, not
 *                starved, so neither re-enqueue nor spend a retry on it.
 */
// The backoff measures "delivered, and STILL not drained", not "enqueued": a
// queued nudge only reaches the terminal once the agent is idle and off cooldown,
// which can be a minute or more. Timing the gap from the enqueue would let the
// gap expire while the first nudge was still waiting its turn, and the retry
// would land seconds after the agent finally read its mail — a "you have new
// inbox message(s)" against an inbox it had just emptied. So `pending` holds the
// clock at `now` as well as freezing the attempt count.
export function nudgeDecision(
  prev: NudgeState | undefined,
  inbox: readonly NudgeableMessage[],
  now: number,
  pending = false
): NudgeDecision {
  const ids = idsOf(inbox);
  // Empty inbox → nothing to say, and the slate is wiped so mail that arrives
  // later (even re-using an id) reads as fresh.
  if (ids.length === 0) return { nudge: false, state: undefined };
  if (pending) return { nudge: false, state: prev ? { ...prev, seen: ids, lastAt: now } : prev };

  const seen = prev ? prev.seen : [];
  const fresh = ids.some((id) => !seen.includes(id));
  // Mail we have never mentioned → nudge now and restart the retry budget.
  if (fresh) return { nudge: true, state: { seen: ids, attempts: 1, lastAt: now } };

  const attempts = prev ? prev.attempts : 0;
  // Same mail, still undrained. Retry while budget remains and the gap has passed.
  if (attempts > 0 && attempts < MAX_NUDGE_ATTEMPTS) {
    const gap = NUDGE_RETRY_MS[attempts - 1];
    if (now - (prev ? prev.lastAt : 0) >= gap) {
      return { nudge: true, state: { seen: ids, attempts: attempts + 1, lastAt: now } };
    }
  }
  // Nothing to do — but keep `seen` tracking the live inbox so a drained id that
  // comes back later is fresh again.
  return { nudge: false, state: { seen: ids, attempts, lastAt: prev ? prev.lastAt : now } };
}
