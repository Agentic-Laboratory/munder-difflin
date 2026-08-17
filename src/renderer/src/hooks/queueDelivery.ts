/** Run one queued delivery and acknowledge it only after the sender resolves.
 * Rejections deliberately leave the queue item untouched for the next retry. */
export async function deliverWithAcknowledgement(
  send: () => Promise<void>,
  acknowledge: () => void
): Promise<boolean> {
  try {
    await send();
    acknowledge();
    return true;
  } catch {
    return false;
  }
}

/**
 * May the drain type into this agent's terminal right now?
 *
 * The gate used to be `status === 'idle'`, full stop, and that stranded mail
 * indefinitely. `looping` is not a terminal state the agent recovers from on its
 * own — it is the circuit breaker's PIN, re-asserted on every beat for as long
 * as the agent is `constrained` or `stopped`. The PTY-quiescence fallback only
 * un-pins `working`, so a breaker-armed agent never returned to `idle` and its
 * queue never drained. Observed live: an agent over its token cap sat pinned
 * while a nudge enqueued two seconds after the message landed went undelivered
 * for minutes, until something outside the app woke it.
 *
 * That is self-defeating, because the breaker STEERS by mailing the agent it
 * armed ("stop, write a plan, send it to god"). Under the old gate the one
 * message meant to unwedge a wedged agent was exactly the message that could
 * never arrive.
 *
 * So a pinned agent is deliverable once its terminal has been silent for
 * `quiesceMs` — the same evidence the idle fallback already trusts to decide a
 * turn is over. The pin stays on the avatar and the badge; it just stops
 * doubling as a delivery lock.
 *
 * Everything else still holds the prompt:
 *   - `working` / `thinking`: mid-turn. The quiescence fallback flips a genuinely
 *     finished turn to `idle`, and then the ordinary gate applies.
 *   - `waiting` / `blocked`: an interactive prompt is on screen. The drain ends
 *     every delivery with Enter, which would ANSWER it — the same reason the
 *     one-time TUI seed refuses to type at those two statuses.
 *
 * Fails CLOSED on an unknown `ptyQuietMs` (no reading, or a PTY that has never
 * emitted): silence we cannot measure is not evidence of silence.
 */
export function canDeliverToAgent(
  status: string,
  ptyQuietMs: number | null,
  quiesceMs: number
): boolean {
  if (status === 'idle') return true;
  if (status !== 'looping') return false;
  return ptyQuietMs !== null && ptyQuietMs >= quiesceMs;
}
