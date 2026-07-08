/**
 * MeetingPanel (OAT-1) — the Meeting-mode tab: record a meeting (mic-only, V1),
 * watch the live transcript build, generate structured AI notes from a muesli
 * template, and browse past meetings. All capture/STT/persistence/LLM work is
 * main-side (see meeting/session.ts + main/meeting.ts + main/db.ts); this
 * component is pure UI over that engine.
 *
 * Notes are markdown source rendered as pre-wrapped text (V1 adds zero deps).
 */
import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { useMeetingSession, meetingSession } from '@/meeting/session';
import { ALL_MEETING_TEMPLATES } from '@shared/meetingTemplates';

// Mirror src/main/db.ts / preload camelCase row shapes (renderer convention:
// re-declare rather than import across the process boundary — cf. TasksKanban).
interface MeetingMeta { id: number; title: string; templateId: string | null; startedAt: number; endedAt: number | null }
interface MeetingTurn { id: number; meetingId: number; seq: number; speaker: string | null; text: string; ts: number }
interface MeetingNote { id: number; meetingId: number; templateId: string | null; content: string; model: string | null; ts: number }

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none'
};
const selectStyle: React.CSSProperties = {
  padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
};
const sectionTitle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, letterSpacing: 0.5,
  textTransform: 'uppercase', color: 'var(--cth-ink-700)', margin: '0 0 6px'
};
const boxStyle: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  padding: 8, fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '18px',
  color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
};

function fmtDate(ms: number): string {
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}
function fmtDuration(a: number, b: number | null): string {
  if (!b || b <= a) return '—';
  const s = Math.round((b - a) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function MeetingPanel() {
  const s = useMeetingSession();
  const recording = s.status === 'recording';
  const finishing = s.status === 'transcribing';
  const transcript = s.turns.map((t) => t.text).join('\n');

  // History + past-meeting viewer.
  const [history, setHistory] = useState<MeetingMeta[]>([]);
  const [viewing, setViewing] = useState<{ meeting: MeetingMeta; turns: MeetingTurn[]; notes: MeetingNote[] } | null>(null);

  const refreshHistory = (): void => {
    window.cth.meetingList({ limit: 50 })
      .then((r) => { if (r.ok) setHistory(r.meetings as MeetingMeta[]); })
      .catch(() => { /* noop */ });
  };
  // Reload history when a recording ends (status returns to idle) so the just-
  // finished meeting shows up.
  useEffect(() => { if (s.status === 'idle') refreshHistory(); }, [s.status]);

  const openMeeting = (id: number): void => {
    window.cth.meetingGet({ meetingId: id })
      .then((r) => {
        if (r.ok && r.meeting) setViewing({ meeting: r.meeting as MeetingMeta, turns: (r.turns ?? []) as MeetingTurn[], notes: (r.notes ?? []) as MeetingNote[] });
      })
      .catch(() => { /* noop */ });
  };

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 14, padding: 12, overflow: 'auto', height: '100%' }}>
      {/* ── Recorder controls ─────────────────────────────────────────────── */}
      <div>
        <p style={sectionTitle}>Meeting</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{ ...inputStyle, flex: '1 1 180px', minWidth: 140 }}
            placeholder="Meeting title (optional)"
            value={s.title}
            disabled={recording || finishing}
            onChange={(e) => meetingSession.setTitle(e.target.value)}
          />
          <select
            style={selectStyle}
            value={s.templateId}
            disabled={recording || finishing}
            onChange={(e) => meetingSession.setTemplate(e.target.value)}
            title="Note template"
          >
            {ALL_MEETING_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
          {recording || finishing ? (
            <PixelButton variant="destructive" onClick={() => void meetingSession.stop()} disabled={finishing}>
              {finishing ? 'finishing…' : '■ stop'}
            </PixelButton>
          ) : (
            <PixelButton variant="primary" onClick={() => void meetingSession.start(s.title, s.templateId)}>
              ● record
            </PixelButton>
          )}
        </div>
        {recording && (
          <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)' }}>
            ● recording — mic only. Transcribing every {Math.round(20)}s.
          </p>
        )}
        {s.error && (
          <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--cth-danger-600, #b00)', fontFamily: 'var(--cth-font-ui)' }}>
            {s.error}
          </p>
        )}
      </div>

      {/* ── Live transcript ───────────────────────────────────────────────── */}
      <div>
        <p style={sectionTitle}>Transcript {s.turns.length > 0 ? `(${s.turns.length})` : ''}</p>
        <div style={{ ...boxStyle, minHeight: 80, maxHeight: 220, overflow: 'auto' }}>
          {transcript || (recording ? 'listening…' : 'No transcript yet. Press ● record to start.')}
        </div>
      </div>

      {/* ── AI notes ──────────────────────────────────────────────────────── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <p style={{ ...sectionTitle, margin: 0 }}>AI notes</p>
          <PixelButton
            size="sm"
            variant="secondary"
            disabled={s.meetingId == null || s.turns.length === 0 || s.notesLoading || recording}
            onClick={() => void meetingSession.generateNotes()}
          >
            {s.notesLoading ? 'generating…' : '✦ generate notes'}
          </PixelButton>
        </div>
        {s.notes ? (
          <div style={boxStyle}>{s.notes}</div>
        ) : (
          <div style={{ ...boxStyle, color: 'var(--cth-ink-700)' }}>
            {s.meetingId == null ? 'Record a meeting, then generate notes.' : 'No notes yet — generate from the transcript above.'}
          </div>
        )}
      </div>

      {/* ── History ───────────────────────────────────────────────────────── */}
      <div>
        <p style={sectionTitle}>Past meetings</p>
        {history.length === 0 ? (
          <div style={{ ...boxStyle, color: 'var(--cth-ink-700)' }}>No past meetings.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {history.map((m) => (
              <button
                key={m.id}
                onClick={() => openMeeting(m.id)}
                style={{
                  textAlign: 'left', cursor: 'pointer', background: 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', border: 'none', padding: '6px 8px',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              >
                <strong>{m.title}</strong>
                <span style={{ color: 'var(--cth-ink-700)', marginLeft: 8, fontSize: 11 }}>
                  {fmtDate(m.startedAt)} · {fmtDuration(m.startedAt, m.endedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Past-meeting viewer (modal-ish inline overlay) ────────────────── */}
      {viewing && (
        <div
          onClick={() => setViewing(null)}
          style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 20
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--cth-paper-50, var(--cth-paper-100))', boxShadow: '0 0 0 2px var(--cth-ink-900)',
              maxWidth: 560, width: '100%', maxHeight: '80%', overflow: 'auto', padding: 14,
              display: 'flex', flexDirection: 'column', gap: 12
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14 }}>{viewing.meeting.title}</strong>
              <PixelButton size="sm" variant="ghost" onClick={() => setViewing(null)}>✕ close</PixelButton>
            </div>
            <div>
              <p style={sectionTitle}>Transcript</p>
              <div style={{ ...boxStyle, maxHeight: 200, overflow: 'auto' }}>
                {viewing.turns.map((t) => t.text).join('\n') || '(empty)'}
              </div>
            </div>
            <div>
              <p style={sectionTitle}>Notes</p>
              {viewing.notes.length > 0 ? (
                <div style={boxStyle}>{viewing.notes[0].content}</div>
              ) : (
                <div style={{ ...boxStyle, color: 'var(--cth-ink-700)' }}>No notes generated for this meeting.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
