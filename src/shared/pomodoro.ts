/** OAT-4 — Pomodoro wire types shared across main (engine), preload (bridge),
 *  and renderer (UI). Pure types only — no electron/node imports — so preload and
 *  the renderer can reference the shape without pulling in the main-side engine. */

export type PomodoroPhase = 'idle' | 'work' | 'shortBreak' | 'longBreak';

/** A snapshot of the live timer, pushed to the renderer on every transition and
 *  returned by `pomodoro:state`. While running and not paused the renderer ticks
 *  the countdown locally from `phaseEndsAt`; while paused it shows `remainingMs`. */
export interface PomodoroState {
  running: boolean;
  paused: boolean;
  phase: PomodoroPhase;
  /** epoch ms when the current phase ends; 0 when idle or paused. */
  phaseEndsAt: number;
  /** authoritative remaining ms (the frozen value while paused). */
  remainingMs: number;
  /** completed work sessions in the current long-break cycle. */
  completedWorkSessions: number;
  /** echoed from config so the UI can render the cycle progress ring. */
  sessionsBeforeLongBreak: number;
}
