/**
 * PersistStore — durable harness state in SQLite (better-sqlite3, synchronous).
 *
 * Phase A scope (the rest of the renderer state stays in localStorage for now):
 *   - kv:               scalar app state. Today: the main window's bounds.
 *   - command_history:  NET-NEW — every prompt the user submits to an agent.
 *
 * Lives in the Electron MAIN process (better-sqlite3 is native + synchronous);
 * the renderer reaches it over IPC. The DB file sits next to config.json under
 * app.getPath('userData'). WAL mode so reads never block the single writer.
 *
 * Schema evolves via PRAGMA user_version migrations: an ordered array where
 * migration N runs when user_version < N+1, then bumps it. NEVER edit a shipped
 * migration — only append. Phases B/C (agents + message_queue mirror) and the
 * cross-lane cost_ledger are reserved as future additive migrations (see below);
 * they are deliberately NOT built in v1.
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';

/** A captured user prompt, as returned to the renderer (camelCase columns). */
export interface CommandHistoryRow {
  id: number;
  agentId: string;
  cwd: string | null;
  text: string;
  ts: number;
}

// ─── Meeting mode (OAT-1) — additive rows (user_version 2) ───────────────────
/** A recorded meeting session (camelCase columns for the renderer). */
export interface MeetingRow {
  id: number;
  title: string;
  templateId: string | null;
  startedAt: number;
  /** null while recording; set on stop. */
  endedAt: number | null;
}
/** One transcribed chunk of a meeting. `speaker` is a Phase-2 diarization seam
 *  (always null in V1 mic-only capture). */
export interface MeetingTurnRow {
  id: number;
  meetingId: number;
  seq: number;
  speaker: string | null;
  text: string;
  ts: number;
}
/** One generated AI-notes summary for a meeting (a meeting may be summarized
 *  multiple times / with different templates). */
export interface MeetingNoteRow {
  id: number;
  meetingId: number;
  templateId: string | null;
  content: string;
  model: string | null;
  ts: number;
}

/**
 * Ordered, append-only migrations. Index N takes the DB from user_version N to
 * N+1. To evolve the schema, APPEND a new function — never edit an existing one
 * (shipped DBs have already run it).
 *
 * FUTURE (do NOT build in v1 — reserved so the array isn't painted into a corner):
 *   - Phase B: `agents` + `message_queue` mirror of the renderer roster/queues
 *     (dual-write), enabling the eventual authority flip off localStorage.
 *   - Cross-lane (Lane A #6): migrate Jim's cost ledger onto this DB so his
 *     circuit-breaker can move off transcript-polling. Column names match his
 *     <harnessHome>/hive/cost-ledger.jsonl keys 1:1 for a straight INSERT…SELECT
 *     (coordinated w/ jim-mq290qkn 2026-06-06):
 *       cost_ledger(id, agent_id, session_id TEXT, ts, input, output,
 *                   cache_read, cache_creation, model TEXT, usd REAL)
 *     Rows are CUMULATIVE snapshots (one per agent per heartbeat beat) — diff
 *     consecutive rows for velocity; index (agent_id, session_id, ts). Additive;
 *     lands as a later migration.
 */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // → user_version 1 (Phase A): scalar kv + net-new command history.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,     -- JSON-encoded
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        cwd      TEXT,
        text     TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ch_agent_ts ON command_history(agent_id, ts DESC);
    `);
  },
  // → user_version 2 (OAT-1, Oatmeal): meeting capture + transcript turns + AI notes.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        template_id TEXT,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER
      );
      CREATE TABLE IF NOT EXISTS meeting_turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        speaker    TEXT,               -- Phase-2 diarization seam; NULL in V1
        text       TEXT NOT NULL,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mt_meeting_seq ON meeting_turns(meeting_id, seq);
      CREATE TABLE IF NOT EXISTS meeting_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        template_id TEXT,
        content     TEXT NOT NULL,
        model       TEXT,
        ts          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mn_meeting_ts ON meeting_notes(meeting_id, ts DESC);
    `);
  }
];

export class PersistStore {
  private db: Database.Database | null = null;

  /** @param dbPath  Override the DB location (tests). Defaults to userData/harness.db. */
  constructor(private dbPath?: string) {}

  /** Open (creating if needed) and migrate the DB. Idempotent — a second call is
   *  a no-op. Throws if the native module fails to load or the file is unusable;
   *  callers should guard so a DB failure can't crash app startup. */
  open(): void {
    if (this.db) return;
    const path = this.dbPath ?? join(app.getPath('userData'), 'harness.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    this.migrate(db);
    this.db = db;
  }

  private migrate(db: Database.Database): void {
    const version = db.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      // Each migration + its version bump run in one transaction so a crash
      // mid-migration never leaves a half-applied schema at the wrong version.
      const run = db.transaction(() => {
        MIGRATIONS[i](db);
        db.pragma(`user_version = ${i + 1}`);
      });
      run();
    }
  }

  /** Close the handle (checkpoints WAL). Safe to call when already closed. */
  close(): void {
    try { this.db?.close(); } catch { /* best-effort on shutdown */ }
    this.db = null;
  }

  get isOpen(): boolean { return this.db !== null; }

  // ─── kv (scalar app state) ─────────────────────────────────────────────────

  /** Read a JSON-decoded scalar, or undefined if absent/unparseable. */
  getKv<T = unknown>(key: string): T | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
  }

  /** Upsert a JSON-encoded scalar. */
  setKv(key: string, value: unknown): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value), Date.now());
  }

  // ─── command history (net-new) ─────────────────────────────────────────────

  /** Record one submitted prompt. Empty text or missing agent id are ignored. */
  addHistory(entry: { agentId: string; cwd?: string | null; text: string }): void {
    if (!this.db) return;
    const text = (entry.text ?? '').trim();
    if (!text || !entry.agentId) return;
    this.db.prepare('INSERT INTO command_history (agent_id, cwd, text, ts) VALUES (?, ?, ?, ?)')
      .run(entry.agentId, entry.cwd ?? null, text, Date.now());
  }

  /** Most-recent-first history, optionally scoped to one agent. */
  listHistory(agentId?: string, limit = 100): CommandHistoryRow[] {
    if (!this.db) return [];
    const lim = clampLimit(limit, 100);
    const rows = agentId
      ? this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(agentId, lim)
      : this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(lim);
    return rows as CommandHistoryRow[];
  }

  /** Substring search over prompt text, most-recent-first. */
  searchHistory(query: string, limit = 50): CommandHistoryRow[] {
    if (!this.db) return [];
    const q = (query ?? '').trim();
    if (!q) return [];
    const lim = clampLimit(limit, 50);
    // Escape LIKE wildcards so a literal % or _ in the query isn't a metachar.
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(
      "SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC LIMIT ?"
    ).all(needle, lim) as CommandHistoryRow[];
  }

  // ─── meetings (OAT-1, additive) ─────────────────────────────────────────────

  /** Start a meeting row. Returns the new meeting id (0 if the DB is closed). */
  addMeeting(entry: { title: string; templateId?: string | null }): number {
    if (!this.db) return 0;
    const title = (entry.title ?? '').trim() || 'Untitled meeting';
    const info = this.db.prepare(
      'INSERT INTO meetings (title, template_id, started_at, ended_at) VALUES (?, ?, ?, NULL)'
    ).run(title, entry.templateId ?? null, Date.now());
    return Number(info.lastInsertRowid);
  }

  /** Mark a meeting ended (idempotent — only stamps the first time). */
  endMeeting(id: number): void {
    if (!this.db) return;
    this.db.prepare('UPDATE meetings SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(Date.now(), id);
  }

  /** Rename a meeting (used by auto-title). No-op on empty title. */
  renameMeeting(id: number, title: string): void {
    if (!this.db) return;
    const t = (title ?? '').trim();
    if (!t) return;
    this.db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(t, id);
  }

  /** Most-recent-first meetings. */
  listMeetings(limit = 100): MeetingRow[] {
    if (!this.db) return [];
    const lim = clampLimit(limit, 100);
    return this.db.prepare(
      'SELECT id, title, template_id AS templateId, started_at AS startedAt, ended_at AS endedAt FROM meetings ORDER BY started_at DESC, id DESC LIMIT ?'
    ).all(lim) as MeetingRow[];
  }

  /** One meeting by id, or undefined. */
  getMeeting(id: number): MeetingRow | undefined {
    if (!this.db) return undefined;
    return this.db.prepare(
      'SELECT id, title, template_id AS templateId, started_at AS startedAt, ended_at AS endedAt FROM meetings WHERE id = ?'
    ).get(id) as MeetingRow | undefined;
  }

  /** Append a transcribed turn. Empty text or a bad meeting id are ignored.
   *  Returns the new turn id (0 if skipped). */
  addMeetingTurn(entry: { meetingId: number; seq: number; text: string; speaker?: string | null }): number {
    if (!this.db) return 0;
    const text = (entry.text ?? '').trim();
    if (!text || !Number.isFinite(entry.meetingId) || entry.meetingId <= 0) return 0;
    const info = this.db.prepare(
      'INSERT INTO meeting_turns (meeting_id, seq, speaker, text, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(entry.meetingId, Math.max(0, Math.floor(entry.seq || 0)), entry.speaker ?? null, text, Date.now());
    return Number(info.lastInsertRowid);
  }

  /** All turns for a meeting, in capture order. */
  listMeetingTurns(meetingId: number): MeetingTurnRow[] {
    if (!this.db) return [];
    return this.db.prepare(
      'SELECT id, meeting_id AS meetingId, seq, speaker, text, ts FROM meeting_turns WHERE meeting_id = ? ORDER BY seq ASC, id ASC'
    ).all(meetingId) as MeetingTurnRow[];
  }

  /** Store a generated notes summary. Returns the new note id (0 if skipped). */
  addMeetingNote(entry: { meetingId: number; templateId?: string | null; content: string; model?: string | null }): number {
    if (!this.db) return 0;
    const content = (entry.content ?? '').trim();
    if (!content || !Number.isFinite(entry.meetingId) || entry.meetingId <= 0) return 0;
    const info = this.db.prepare(
      'INSERT INTO meeting_notes (meeting_id, template_id, content, model, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(entry.meetingId, entry.templateId ?? null, content, entry.model ?? null, Date.now());
    return Number(info.lastInsertRowid);
  }

  /** Notes for a meeting, newest-first. */
  listMeetingNotes(meetingId: number): MeetingNoteRow[] {
    if (!this.db) return [];
    return this.db.prepare(
      'SELECT id, meeting_id AS meetingId, template_id AS templateId, content, model, ts FROM meeting_notes WHERE meeting_id = ? ORDER BY ts DESC, id DESC'
    ).all(meetingId) as MeetingNoteRow[];
  }
}

/** Coerce an untrusted limit into [1, 1000] with a sane fallback. */
function clampLimit(n: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1000, v);
}
