import { Notification } from 'electron';
import { readConfig, writeConfig, type PomodoroConfig } from './config';
import type { PomodoroPhase, PomodoroState } from '../shared/pomodoro';

export type { PomodoroPhase, PomodoroState } from '../shared/pomodoro';

/**
 * OAT-4 — Pomodoro focus timer + reminder scheduler (main-side).
 *
 * Both mirror the `syncMissions` scheduler in index.ts: a `setTimeout` waits out
 * the time remaining until the next fire, and (for the recurring reminders) it
 * then settles into a steady `setInterval`. Every timer is tracked so app teardown
 * can clear whichever is pending, and each fire raises a native `Notification`
 * (same helper shape as the breaker toast: `Notification.isSupported()` guard).
 *
 * The renderer holds ZERO policy: it only invokes the control IPC and renders the
 * `PomodoroState` snapshots this engine emits. No key/secret/fs work happens here.
 */

const DEFAULT_POMODORO: PomodoroConfig = {
  enabled: false,
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  notify: true
};

/** Injected side-effects so this module stays decoupled from index.ts (the emit
 *  closure forwards to the live renderer via liveWebContents). */
export interface PomodoroDeps {
  emit: (channel: string, payload: unknown) => void;
}

let deps: PomodoroDeps = { emit: () => { /* no renderer yet */ } };

/** Wire the renderer emitter. Called once from index.ts after app-ready. */
export function initPomodoro(d: PomodoroDeps): void {
  deps = d;
}

/** A native toast, gated on platform support. Pomodoro/reminder toasts are gated
 *  by their own enabled/notify flags at the call site (not the global
 *  `config.notifications`, which is specifically agent-lifecycle events). */
function notify(title: string, body: string): void {
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
  catch { /* unsupported platform */ }
}

function pomodoroCfg(): PomodoroConfig {
  return readConfig().pomodoro ?? DEFAULT_POMODORO;
}

/** Clamp a minutes value to a sane positive millisecond duration (min 1s) so a
 *  zero/NaN config can never spin a phase into an instant-fire loop. */
function phaseMs(minutes: number): number {
  const m = Number(minutes);
  return Math.max(1000, Math.round((Number.isFinite(m) ? m : 0) * 60_000)) || 1000;
}

class PomodoroEngine {
  private timeout: NodeJS.Timeout | null = null;
  private phase: PomodoroPhase = 'idle';
  private paused = false;
  private phaseEndsAt = 0;
  private pausedRemaining = 0;
  private completedWorkSessions = 0;

  getState(): PomodoroState {
    const cfg = pomodoroCfg();
    const running = this.phase !== 'idle';
    const remainingMs = running
      ? (this.paused ? this.pausedRemaining : Math.max(0, this.phaseEndsAt - Date.now()))
      : 0;
    return {
      running,
      paused: this.paused,
      phase: this.phase,
      phaseEndsAt: this.paused ? 0 : this.phaseEndsAt,
      remainingMs,
      completedWorkSessions: this.completedWorkSessions,
      sessionsBeforeLongBreak: Math.max(1, Math.round(cfg.sessionsBeforeLongBreak) || 4)
    };
  }

  private emit(): void {
    deps.emit('pomodoro:state', this.getState());
  }

  private clearTimer(): void {
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
  }

  /** Arm the current `this.phase` for its configured duration. */
  private armPhase(): void {
    this.clearTimer();
    const cfg = pomodoroCfg();
    const minutes =
      this.phase === 'work' ? cfg.workMinutes
      : this.phase === 'longBreak' ? cfg.longBreakMinutes
      : cfg.shortBreakMinutes;
    const ms = phaseMs(minutes);
    this.phaseEndsAt = Date.now() + ms;
    this.paused = false;
    this.pausedRemaining = 0;
    this.timeout = setTimeout(() => this.onPhaseEnd(), ms);
    this.emit();
  }

  /** Compute + enter the phase that follows the one that just ended. */
  private nextPhaseAfter(ended: PomodoroPhase): PomodoroPhase {
    const cfg = pomodoroCfg();
    const cycle = Math.max(1, Math.round(cfg.sessionsBeforeLongBreak) || 4);
    if (ended === 'work') {
      this.completedWorkSessions += 1;
      return this.completedWorkSessions % cycle === 0 ? 'longBreak' : 'shortBreak';
    }
    // A long break closes a cycle — reset the session counter.
    if (ended === 'longBreak') this.completedWorkSessions = 0;
    return 'work';
  }

  private phaseLabel(p: PomodoroPhase): string {
    return p === 'work' ? 'Focus' : p === 'longBreak' ? 'Long break' : 'Break';
  }

  private onPhaseEnd(): void {
    const ended = this.phase;
    const next = this.nextPhaseAfter(ended);
    this.phase = next;
    if (pomodoroCfg().notify !== false) {
      const body = next === 'work'
        ? 'Break over — back to focus.'
        : `Focus session done (${this.completedWorkSessions}). Time for a ${this.phaseLabel(next).toLowerCase()}.`;
      notify(`Pomodoro — ${this.phaseLabel(next)}`, body);
    }
    this.armPhase();
  }

  /** Begin a fresh Pomodoro from a work session. No-op when the feature is off. */
  start(): PomodoroState {
    if (!pomodoroCfg().enabled) return this.getState();
    this.completedWorkSessions = 0;
    this.phase = 'work';
    this.armPhase();
    return this.getState();
  }

  pause(): PomodoroState {
    if (this.phase === 'idle' || this.paused) return this.getState();
    this.pausedRemaining = Math.max(0, this.phaseEndsAt - Date.now());
    this.paused = true;
    this.clearTimer();
    this.emit();
    return this.getState();
  }

  resume(): PomodoroState {
    if (this.phase === 'idle' || !this.paused) return this.getState();
    const ms = Math.max(0, this.pausedRemaining);
    this.phaseEndsAt = Date.now() + ms;
    this.paused = false;
    this.pausedRemaining = 0;
    this.timeout = setTimeout(() => this.onPhaseEnd(), ms);
    this.emit();
    return this.getState();
  }

  /** Manually jump to the next phase now (no notification — the user did it). */
  skip(): PomodoroState {
    if (this.phase === 'idle') return this.getState();
    this.phase = this.nextPhaseAfter(this.phase);
    this.armPhase();
    return this.getState();
  }

  reset(): PomodoroState {
    this.clearTimer();
    this.phase = 'idle';
    this.paused = false;
    this.phaseEndsAt = 0;
    this.pausedRemaining = 0;
    this.completedWorkSessions = 0;
    this.emit();
    return this.getState();
  }

  /** Teardown for app quit — clear the pending timer without emitting. */
  dispose(): void {
    this.clearTimer();
  }
}

/** Process-global Pomodoro singleton. */
export const pomodoro = new PomodoroEngine();

// ─── Reminders scheduler (recurring native toasts) ───────────────────────────

interface ReminderTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

const reminderTimers = new Map<string, ReminderTimer>();

/** Clear and forget every armed reminder timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncReminders and shutdown teardown. */
export function clearReminderTimers(): void {
  for (const t of reminderTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  reminderTimers.clear();
}

/** Rebuild the reminder scheduler from persisted config: clear every existing
 *  timer, then arm each enabled reminder honoring its lastFiredAt — a setTimeout
 *  for the time remaining until its next due fire, which then settles into a
 *  steady interval. Each tick raises a native Notification and stamps lastFiredAt
 *  back into config. Called on boot and after every reminders edit (reminders:sync).
 *  Mirrors syncMissions in index.ts. */
export function syncReminders(): void {
  clearReminderTimers();
  const reminders = readConfig().reminders ?? [];
  for (const r of reminders) {
    if (!r.enabled || !(r.intervalMs > 0)) continue;
    const fire = (): void => {
      try {
        notify(r.label?.trim() || 'Reminder', 'Reminder');
        const current = readConfig().reminders ?? [];
        const next = current.map((x) =>
          x.id === r.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ reminders: next });
        deps.emit('reminders:updated', { id: r.id });
      } catch (e) {
        console.error('[pomodoro] reminder', r.id, e);
      }
    };
    // A never-fired reminder (lastFiredAt undefined) waits a FULL interval from
    // now — treat "now" as its base so a fresh reminder doesn't fire instantly on
    // sync (the (now - 0) blowup the missions code avoids by seeding lastFiredAt).
    const base = r.lastFiredAt ?? Date.now();
    const remaining = Math.max(0, r.intervalMs - (Date.now() - base));
    const entry: ReminderTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, r.intervalMs);
    }, remaining);
    reminderTimers.set(r.id, entry);
  }
}
