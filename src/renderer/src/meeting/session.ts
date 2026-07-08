/**
 * Meeting mode (OAT-1) — renderer capture singleton. Mirrors the Free Flow
 * recorder pattern (freeflow/recorder.ts): a module-level state machine exposed
 * via `useSyncExternalStore`, NOT the Zustand store, so only one meeting records
 * at a time and any component can subscribe.
 *
 * V1 = MIC-ONLY. Capture strategy: keep one mic MediaStream open for the whole
 * meeting and cut it into fixed-length CHUNK_MS webm clips by stopping+restarting
 * a MediaRecorder each interval (a fresh recorder per chunk yields a complete,
 * independently-decodable webm that Groq Whisper can transcribe — a single
 * timesliced recorder does NOT, since later fragments lack the header). Each clip
 * is sent to main (`meetingTranscribeChunk`), transcribed, and persisted as a
 * turn; the returned text is appended to the live transcript. The renderer holds
 * ZERO policy: STT, persistence, and notes generation all happen main-side.
 *
 * Phase 2 (out of scope): system-audio loopback + diarization (see main/meeting.ts
 * `SystemAudioSource`).
 */
import { useSyncExternalStore } from 'react';
import { AUTO_TEMPLATE } from '@shared/meetingTemplates';

/** Seconds of audio per transcribe chunk — trades latency vs. Whisper accuracy. */
const CHUNK_MS = 20_000;

export type MeetingStatus = 'idle' | 'recording' | 'transcribing';

/** One live transcript line (kept ordered by capture `seq`). */
export interface LiveTurn {
  seq: number;
  text: string;
}

export interface MeetingSessionState {
  status: MeetingStatus;
  /** The active/last meeting id (persists after stop so notes can be generated). */
  meetingId: number | null;
  title: string;
  /** Selected note template id (editable only while idle). */
  templateId: string;
  turns: LiveTurn[];
  /** Latest generated notes markdown, or null. */
  notes: string | null;
  /** True while a summarize request is in flight. */
  notesLoading: boolean;
  /** Last non-fatal error (mic denied, a chunk failing to transcribe…). */
  error: string | null;
}

let state: MeetingSessionState = {
  status: 'idle',
  meetingId: null,
  title: '',
  templateId: AUTO_TEMPLATE.id,
  turns: [],
  notes: null,
  notesLoading: false,
  error: null
};

const listeners = new Set<() => void>();

function setState(patch: Partial<MeetingSessionState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): MeetingSessionState {
  return state;
}

// ─── Capture internals ───────────────────────────────────────────────────────
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let running = false;
let nextSeq = 0;
let chunkTimer: ReturnType<typeof setTimeout> | null = null;

/** Prefer webm/opus (Groq-supported, Chromium default); fall back to platform default. */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const supported = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
  if (supported) {
    for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function teardownStream(): void {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
  stream = null;
  recorder = null;
}

/** Insert a transcribed turn keeping the list ordered by seq (chunks resolve
 *  out of order because transcription is async). */
function appendTurn(seq: number, text: string): void {
  const turns = [...state.turns, { seq, text }].sort((a, b) => a.seq - b.seq);
  setState({ turns });
}

/** Record one CHUNK_MS clip, then (if still running) immediately begin the next so
 *  capture stays continuous while the finished clip transcribes in the background. */
function cycle(): void {
  if (!running || !stream) return;
  const localChunks: Blob[] = [];
  const mimeType = pickMimeType();
  let rec: MediaRecorder;
  try {
    rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    running = false;
    teardownStream();
    setState({ status: 'idle', error: 'recording not supported' });
    return;
  }
  recorder = rec;
  rec.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size > 0) localChunks.push(ev.data); };
  rec.onstop = () => {
    const type = rec.mimeType || 'audio/webm';
    const blob = new Blob(localChunks, { type });
    if (running) {
      cycle();                                   // keep capturing
      void transcribeAndAppend(blob, type);
    } else {
      // Final chunk: transcribe it, then settle back to idle.
      teardownStream();
      void transcribeAndAppend(blob, type).finally(() => setState({ status: 'idle' }));
    }
  };
  rec.start();
  chunkTimer = setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } }, CHUNK_MS);
}

/** Send one clip to main for transcription + persistence; append the text. */
async function transcribeAndAppend(blob: Blob, type: string): Promise<void> {
  if (blob.size === 0 || state.meetingId == null) return;
  const seq = nextSeq++;
  try {
    const buf = await blob.arrayBuffer();
    const ext = type.includes('ogg') ? 'ogg' : 'webm';
    const res = await window.cth.meetingTranscribeChunk({
      meetingId: state.meetingId,
      seq,
      audio: buf,
      mimeType: type.split(';')[0],
      filename: `meeting-chunk.${ext}`
    });
    if (res.ok && res.text) {
      appendTurn(seq, res.text);
      if (state.error) setState({ error: null });
    } else if (res.error) {
      setState({ error: res.error }); // non-fatal — keep recording
    }
  } catch (e) {
    setState({ error: e instanceof Error ? e.message : 'transcription failed' });
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Begin a new meeting. No-op unless idle. Opens the mic and starts chunking. */
async function start(title: string, templateId: string): Promise<void> {
  if (state.status !== 'idle') return;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    setState({ error: 'microphone not available' });
    return;
  }
  setState({ error: null, notes: null, turns: [] });
  const startRes = await window.cth.meetingStart({ title: title.trim() || 'Untitled meeting', templateId });
  if (!startRes.ok || !startRes.meetingId) {
    setState({ error: startRes.error || 'could not start meeting' });
    return;
  }
  let opened: MediaStream;
  try {
    opened = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    // Roll the just-created meeting shut so it isn't left dangling.
    try { await window.cth.meetingStop({ meetingId: startRes.meetingId }); } catch { /* noop */ }
    setState({ error: name === 'NotAllowedError' ? 'microphone permission denied' : 'could not open microphone' });
    return;
  }
  stream = opened;
  running = true;
  nextSeq = 0;
  setState({ status: 'recording', meetingId: startRes.meetingId, title: title.trim() || 'Untitled meeting', templateId });
  cycle();
}

/** Stop recording. The in-flight chunk finishes + transcribes, then status → idle. */
async function stop(): Promise<void> {
  if (state.status !== 'recording') return;
  running = false;
  if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
  setState({ status: 'transcribing' }); // finishing the last clip
  const id = state.meetingId;
  try { recorder?.stop(); } catch { /* already stopped */ }
  if (!recorder) { teardownStream(); setState({ status: 'idle' }); }
  if (id != null) {
    try { await window.cth.meetingStop({ meetingId: id }); } catch { /* best-effort */ }
  }
}

/** Generate AI notes for the current meeting (transcript is read main-side). */
async function generateNotes(templateId?: string): Promise<void> {
  if (state.meetingId == null || state.notesLoading) return;
  setState({ notesLoading: true, error: null });
  try {
    const res = await window.cth.notesSummarize({ meetingId: state.meetingId, templateId: templateId ?? state.templateId });
    if (res.ok && res.notes) setState({ notes: res.notes });
    else setState({ error: res.error || 'could not generate notes' });
  } catch (e) {
    setState({ error: e instanceof Error ? e.message : 'could not generate notes' });
  } finally {
    setState({ notesLoading: false });
  }
}

/** Set the note template (only meaningful while idle / before recording). */
function setTemplate(templateId: string): void {
  setState({ templateId });
}

/** Set the meeting title (only while idle). */
function setTitle(title: string): void {
  if (state.status === 'idle') setState({ title });
}

export const meetingSession = {
  start,
  stop,
  generateNotes,
  setTemplate,
  setTitle,
  subscribe,
  getSnapshot
};

/** React hook: subscribe to the shared meeting-session state. */
export function useMeetingSession(): MeetingSessionState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
