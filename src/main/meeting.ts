/**
 * Meeting mode (OAT-1) — main-process engine for Granola-style meeting capture +
 * AI notes. V1 is MIC-ONLY and reuse-first:
 *   - STT: reuses `transcribeWithGroq` (Groq whisper-large-v3-turbo) on the mic
 *     chunks the renderer records + hands over IPC. Same key-stays-in-main contract
 *     as Free Flow — only audio bytes cross inbound, transcript text outbound.
 *   - AI notes: reuses `groqChat` with muesli's verbatim note templates + the
 *     prompt-injection guard (see src/shared/meetingTemplates.ts).
 *
 * This module holds NO electron/db imports so it stays pure + unit-testable; the
 * IPC layer (index.ts) owns config reads + persistence (PersistStore). The Groq
 * key is passed in from main config and used ONLY for Authorization — never logged.
 *
 * PHASE 2 (fenced, NOT implemented): system-audio loopback capture + speaker
 * diarization. The `SystemAudioSource` seam below reserves that shape so a later
 * change can add it without reworking the mic path.
 */
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from './freeflow';
import { groqChat } from './groq';
import { buildSummaryInstructions, buildSummaryUserPrompt } from '../shared/meetingTemplates';

/**
 * Notes model. V1 reuses the app's proven Groq chat default so it is guaranteed
 * available; kept as a single seam so a stronger summarizer can be swapped later.
 */
export const MEETING_NOTES_MODEL = 'llama-3.3-70b-versatile';

/** groqChat caps prompts at 80k chars; keep transcript well under that with room
 *  for the template + framing. Oldest-first truncation keeps the recent tail. */
const MAX_TRANSCRIPT_CHARS = 60_000;

export interface TranscribeChunkInput {
  apiKey: string;
  audio: ArrayBuffer | Uint8Array;
  mimeType?: string;
  filename?: string;
  model?: string;
  language?: string;
}

/**
 * Transcribe one recorded mic chunk. Thin wrapper over the Free Flow Groq path so
 * meeting + dictation share one STT engine. Never throws; never logs the key.
 */
export async function transcribeMeetingChunk(
  input: TranscribeChunkInput
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!(input.audio instanceof ArrayBuffer) && !(input.audio instanceof Uint8Array)) {
    return { ok: false, error: 'no audio' };
  }
  return transcribeWithGroq({
    apiKey: input.apiKey,
    audio: input.audio,
    mimeType: input.mimeType,
    filename: input.filename ?? 'meeting-chunk.webm',
    model: input.model || DEFAULT_GROQ_MODEL,
    language: input.language
  });
}

export interface SummarizeInput {
  apiKey: string;
  /** Full concatenated transcript (turns joined newest-appended). */
  transcript: string;
  /** Meeting title for prompt framing. */
  title: string;
  /** Template id (auto / one-to-one / …); resolved against meetingTemplates. */
  templateId?: string | null;
  /** Optional model override; defaults to MEETING_NOTES_MODEL. */
  model?: string;
  signal?: AbortSignal;
}

/**
 * Generate structured markdown meeting notes from a transcript via groqChat +
 * the muesli template. The transcript is untrusted text: `groqChat` already wraps
 * user content in `<untrusted-user-data>` AND the base instructions carry muesli's
 * injection guard, so a transcript can't hijack the notes model.
 */
export async function summarizeMeeting(
  input: SummarizeInput
): Promise<{ ok: boolean; notes?: string; model?: string; error?: string }> {
  const transcript = (input.transcript ?? '').trim();
  if (!transcript) return { ok: false, error: 'no transcript to summarize' };

  const clipped = clampTranscript(transcript);
  const system = buildSummaryInstructions(input.templateId);
  const user = buildSummaryUserPrompt(clipped, input.title);

  const res = await groqChat({
    apiKey: input.apiKey,
    model: input.model || MEETING_NOTES_MODEL,
    temperature: 0.2,
    signal: input.signal,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, notes: res.text, model: res.model };
}

/** Keep only the most recent MAX_TRANSCRIPT_CHARS, dropping the oldest lines. */
function clampTranscript(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const tail = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  // Snap to a line boundary so we don't start mid-sentence.
  const nl = tail.indexOf('\n');
  return (nl > 0 ? tail.slice(nl + 1) : tail);
}

// ─── PHASE 2 seam (NOT implemented in V1) ────────────────────────────────────
/**
 * Reserved capture-source abstraction. V1 meeting capture is mic-only via the
 * renderer MediaRecorder path; system-audio loopback + diarization are Phase 2
 * (need `setDisplayMediaRequestHandler(…, 'loopback')` / native modules — out of
 * V1 scope per OATMEAL-INTEGRATION-PLAN §7). This interface exists ONLY so a later
 * change can add a system-audio source without reshaping the mic engine.
 */
export interface MeetingAudioSource {
  readonly kind: 'mic' | 'system';
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Phase-2 stub. Intentionally inert — throws if anyone wires it up early. */
export class SystemAudioSource implements MeetingAudioSource {
  readonly kind = 'system' as const;
  async start(): Promise<void> {
    throw new Error('system-audio capture is Phase 2 (not implemented in V1 — mic only)');
  }
  async stop(): Promise<void> {
    /* no-op: never started in V1 */
  }
}
