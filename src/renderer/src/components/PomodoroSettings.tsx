import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import type { HarnessConfig, PomodoroConfig, Reminder } from '@/store/config';
import type { PomodoroState } from '@shared/pomodoro';

/** OAT-4 — Pomodoro + reminders settings section. All timer/notification policy
 *  is main-side (src/main/pomodoro.ts); this panel only edits config (persisted
 *  via updateConfig), drives the engine controls, and renders the state pushes. */

const DEFAULT_POMODORO: PomodoroConfig = {
  enabled: false,
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  notify: true
};

const headerStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
};
const inputStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 13,
  padding: '6px 8px', border: '1.5px solid var(--cth-ink-300)', borderRadius: 2,
  background: 'var(--cth-cream-50)', color: 'var(--cth-ink-900)', width: 88
};
const labelStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)'
};
const phaseTitle = (p: PomodoroState['phase']): string =>
  p === 'work' ? 'Focus' : p === 'longBreak' ? 'Long break' : p === 'shortBreak' ? 'Break' : 'Idle';

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function PomodoroSettings({ config }: { config: HarnessConfig }) {
  const [pom, setPom] = useState<PomodoroConfig>({ ...DEFAULT_POMODORO, ...(config.pomodoro ?? {}) });
  const [reminders, setReminders] = useState<Reminder[]>(config.reminders ?? []);
  const [state, setState] = useState<PomodoroState | null>(null);
  const [, setTick] = useState(0);
  const [newLabel, setNewLabel] = useState('');
  const [newMinutes, setNewMinutes] = useState('30');
  const pomRef = useRef(pom);
  pomRef.current = pom;

  // Subscribe to the engine's state pushes + fetch the current snapshot on mount.
  useEffect(() => {
    let alive = true;
    window.cth.pomodoroState().then((s) => { if (alive) setState(s); }).catch(() => {});
    const off = window.cth.onPomodoroState((s) => setState(s));
    return () => { alive = false; off(); };
  }, []);

  // Tick once a second so the countdown re-renders while a phase is running.
  useEffect(() => {
    if (!state?.running || state.paused) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [state?.running, state?.paused]);

  const persistPomodoro = useCallback((next: PomodoroConfig) => {
    setPom(next);
    void window.cth.updateConfig({ pomodoro: next });
  }, []);

  const setField = (k: keyof PomodoroConfig, v: number | boolean) =>
    persistPomodoro({ ...pomRef.current, [k]: v });

  const numField = (k: keyof PomodoroConfig, raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) setField(k, Math.round(n));
  };

  const toggleEnabled = () => {
    const next = { ...pom, enabled: !pom.enabled };
    persistPomodoro(next);
    // Turning the feature off stops any live session.
    if (!next.enabled) void window.cth.pomodoroReset().then(setState);
  };

  const persistReminders = useCallback((next: Reminder[]) => {
    setReminders(next);
    void window.cth.updateConfig({ reminders: next }).then(() => window.cth.remindersSync());
  }, []);

  const addReminder = () => {
    const mins = Number(newMinutes);
    const label = newLabel.trim();
    if (!label || !Number.isFinite(mins) || mins <= 0) return;
    const r: Reminder = {
      id: (crypto?.randomUUID?.() ?? `rem-${Date.now()}`),
      label,
      intervalMs: Math.round(mins) * 60_000,
      enabled: true
    };
    persistReminders([...reminders, r]);
    setNewLabel('');
    setNewMinutes('30');
  };

  const remaining = state
    ? (state.paused ? state.remainingMs : Math.max(0, state.phaseEndsAt - Date.now()))
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* ── Live timer ─────────────────────────────────────────────── */}
      <div>
        <div style={headerStyle}>Pomodoro</div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '12px 14px', border: '2px solid var(--cth-ink-300)', borderRadius: 3,
          background: 'var(--cth-cream-100)'
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
              {state?.running ? phaseTitle(state.phase) : 'Ready'}
            </span>
            <span style={{
              fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 34, lineHeight: '38px',
              color: 'var(--cth-ink-900)', fontVariantNumeric: 'tabular-nums'
            }}>
              {state?.running ? fmtClock(remaining) : fmtClock(pom.workMinutes * 60_000)}
            </span>
            {state?.running && (
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                session {state.completedWorkSessions % state.sessionsBeforeLongBreak + (state.phase === 'work' ? 1 : 0)} / {state.sessionsBeforeLongBreak}
                {state.paused ? ' · paused' : ''}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {!state?.running && (
              <PixelButton variant="primary" size="sm" disabled={!pom.enabled}
                onClick={() => window.cth.pomodoroStart().then(setState)}>start</PixelButton>
            )}
            {state?.running && !state.paused && (
              <PixelButton variant="secondary" size="sm"
                onClick={() => window.cth.pomodoroPause().then(setState)}>pause</PixelButton>
            )}
            {state?.running && state.paused && (
              <PixelButton variant="primary" size="sm"
                onClick={() => window.cth.pomodoroResume().then(setState)}>resume</PixelButton>
            )}
            {state?.running && (
              <PixelButton variant="secondary" size="sm"
                onClick={() => window.cth.pomodoroSkip().then(setState)}>skip</PixelButton>
            )}
            {state?.running && (
              <PixelButton variant="secondary" size="sm"
                onClick={() => window.cth.pomodoroReset().then(setState)}>reset</PixelButton>
            )}
          </div>
        </div>
        {!pom.enabled && (
          <span style={{ display: 'block', marginTop: 8, fontSize: 12, color: 'var(--cth-ink-500)' }}>
            Enable the timer below to start focus sessions.
          </span>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

      {/* ── Config ─────────────────────────────────────────────────── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>Enable Pomodoro</span>
            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
              Fires a native desktop notification at each work/break transition.
            </span>
          </div>
          <PixelButton variant={pom.enabled ? 'primary' : 'secondary'} size="sm" onClick={toggleEnabled}>
            {pom.enabled ? 'on' : 'off'}
          </PixelButton>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <label style={labelStyle}>work (min)
            <input style={inputStyle} type="number" min="1" step="1" defaultValue={pom.workMinutes}
              onBlur={(e) => numField('workMinutes', e.target.value)} />
          </label>
          <label style={labelStyle}>short break (min)
            <input style={inputStyle} type="number" min="1" step="1" defaultValue={pom.shortBreakMinutes}
              onBlur={(e) => numField('shortBreakMinutes', e.target.value)} />
          </label>
          <label style={labelStyle}>long break (min)
            <input style={inputStyle} type="number" min="1" step="1" defaultValue={pom.longBreakMinutes}
              onBlur={(e) => numField('longBreakMinutes', e.target.value)} />
          </label>
          <label style={labelStyle}>sessions / long break
            <input style={inputStyle} type="number" min="1" step="1" defaultValue={pom.sessionsBeforeLongBreak}
              onBlur={(e) => numField('sessionsBeforeLongBreak', e.target.value)} />
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>Desktop notification on phase change</span>
          <PixelButton variant={pom.notify ? 'primary' : 'secondary'} size="sm"
            onClick={() => setField('notify', !pom.notify)}>
            {pom.notify ? 'on' : 'off'}
          </PixelButton>
        </div>
      </div>

      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

      {/* ── Reminders ──────────────────────────────────────────────── */}
      <div>
        <div style={headerStyle}>Reminders</div>
        <span style={{ display: 'block', marginBottom: 12, fontSize: 12, color: 'var(--cth-ink-500)' }}>
          Each enabled reminder fires a native notification on its interval.
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {reminders.length === 0 && (
            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No reminders yet.</span>
          )}
          {reminders.map((r) => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', border: '1.5px solid var(--cth-ink-300)', borderRadius: 2,
              background: 'var(--cth-cream-50)'
            }}>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--cth-ink-900)', wordBreak: 'break-word' }}>{r.label}</span>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>
                every {Math.round(r.intervalMs / 60_000)} min
              </span>
              <PixelButton variant={r.enabled ? 'primary' : 'secondary'} size="sm"
                onClick={() => persistReminders(reminders.map((x) => x.id === r.id ? { ...x, enabled: !x.enabled } : x))}>
                {r.enabled ? 'on' : 'off'}
              </PixelButton>
              <PixelButton variant="ghost" size="sm"
                onClick={() => persistReminders(reminders.filter((x) => x.id !== r.id))}>remove</PixelButton>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 12 }}>
          <label style={{ ...labelStyle, flex: 1 }}>label
            <input style={{ ...inputStyle, width: '100%' }} type="text" value={newLabel} placeholder="e.g. Stand up & stretch"
              onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addReminder(); }} />
          </label>
          <label style={labelStyle}>every (min)
            <input style={inputStyle} type="number" min="1" step="1" value={newMinutes}
              onChange={(e) => setNewMinutes(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addReminder(); }} />
          </label>
          <PixelButton variant="secondary" size="sm" onClick={addReminder}>add</PixelButton>
        </div>
      </div>
    </div>
  );
}
