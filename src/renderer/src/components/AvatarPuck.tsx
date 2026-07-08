/**
 * OAT-2 — Michael avatar voice puck.
 *
 * Replaces the old RealtimeMichaelToggle mic-button puck with Michael's procedural
 * SpritePortrait avatar (character="michael", no asset needed) and a VISIBLE
 * listening/speaking state. The pose is driven by BOTH voice paths, unified:
 *   - the realtime voice loop  → useRealtimeMichael().status  (off/connecting/
 *     listening/responding→speaking/working)
 *   - Free Flow push-to-talk   → useFreeflow().status         (recording→listening,
 *     transcribing→thinking)
 * so whichever is live lights the same avatar.
 *
 * Click behaviour is unchanged from the old puck: it starts/stops the realtime
 * voice session and stays VISIBLE-but-inert without a BYOK OpenAI key (tooltip →
 * Settings), so connect()/getUserMedia are never reached without a key. The
 * dictation hotkey (config.dictationHotkey, held) drives the listening pose on
 * its own — it uses the Groq key, independent of the realtime OpenAI key.
 *
 * Rendered where RealtimeMichaelToggle was (AgentCard god card + FullscreenTerminal
 * header). State-only / hook-only so both mount points share it.
 */
import { SpritePortrait } from './SpritePortrait';
import { useStore } from '@/store/store';
import { useRealtimeMichael, type RealtimeStatus } from '@/realtime/session';
import { useFreeflow } from '@/freeflow/recorder';
import { DICTATION_HOTKEY_LABELS } from '@/store/config';

/** The unified visual pose the avatar shows. */
type PuckPose = 'off' | 'connecting' | 'listening' | 'speaking' | 'thinking' | 'working';

/** Per-pose presentation: the frame ring accent, a short label, the small
 *  indicator dot's animation (reuses global cth-* keyframes), and whether the
 *  waveform flourish plays (mic-hot poses only). */
const POSE_VIEW: Record<
  PuckPose,
  { ring: string; label: string; dotAnim: string; wave: boolean; help: string }
> = {
  off:        { ring: 'var(--cth-ink-300)', label: 'talk',      dotAnim: 'none',                                   wave: false, help: 'Talk to Michael — start the voice session' },
  connecting: { ring: 'var(--cth-lemon)',   label: '…',         dotAnim: 'cth-blink 700ms steps(2, end) infinite', wave: false, help: 'Connecting to Michael…' },
  listening:  { ring: 'var(--cth-mint)',    label: 'listening', dotAnim: 'cth-pulse 1000ms steps(2, end) infinite', wave: true,  help: 'Listening — your voice is being heard' },
  speaking:   { ring: 'var(--cth-sky)',     label: 'speaking',  dotAnim: 'cth-pulse 600ms steps(2, end) infinite',  wave: true,  help: 'Michael is speaking (click to stop)' },
  thinking:   { ring: 'var(--cth-lemon)',   label: 'thinking',  dotAnim: 'cth-blink 500ms steps(2, end) infinite',  wave: false, help: 'Transcribing your dictation…' },
  working:    { ring: 'var(--cth-coral)',   label: 'working',   dotAnim: 'cth-blink 500ms steps(2, end) infinite',  wave: false, help: 'Michael is running a tool — mic muted (click to stop)' }
};

/** realtime loop status → puck pose ('responding' reads as 'speaking' to the user). */
const RT_TO_POSE: Record<RealtimeStatus, PuckPose> = {
  off: 'off',
  connecting: 'connecting',
  listening: 'listening',
  responding: 'speaking',
  working: 'working'
};

export interface AvatarPuckProps {
  /** Compact form for the fullscreen header / tight rows — hides the text label. */
  compact?: boolean;
  /** Integer sprite scale (SpritePortrait). Default 2 per the OAT-2 spec. */
  scale?: number;
}

export function AvatarPuck({ compact = false, scale = 2 }: AvatarPuckProps) {
  const hasOpenAiKey = useStore((s) => s.hasOpenAiKey);
  const dictationHotkey = useStore((s) => s.dictationHotkey);
  const { status: rtStatus, error, connect, disconnect } = useRealtimeMichael();
  const ff = useFreeflow();

  // Free Flow dictation is a foreground push-to-talk: when its mic is hot it wins
  // the pose; otherwise the realtime loop status drives it.
  const pose: PuckPose =
    ff.status === 'recording' ? 'listening'
    : ff.status === 'transcribing' ? 'thinking'
    : RT_TO_POSE[rtStatus];

  const view = POSE_VIEW[pose];
  const noKey = !hasOpenAiKey;
  const active = pose !== 'off';

  const hotkeyLabel = DICTATION_HOTKEY_LABELS[dictationHotkey] ?? DICTATION_HOTKEY_LABELS.Alt;
  const title = noKey
    ? 'Talk needs your OpenAI API key (used for the Realtime voice API). Add it in Settings → AI Engines.'
    : error
      ? `${view.help} — ${error}`
      : `${view.help} · hold ${hotkeyLabel} to dictate`;

  const onClick = () => {
    if (noKey) return;
    if (rtStatus === 'off') void connect();
    else disconnect();
  };

  return (
    <span
      title={title}
      className="cth-titlebar-nodrag"
      style={{ display: 'inline-flex', alignItems: 'center', gap: noKey && !compact ? 6 : 0 }}
      // Stop the click bubbling to a parent card's onClick (selecting the agent).
      onClick={(e) => e.stopPropagation()}
    >
      {/* Scoped keyframes for the speaking/listening waveform flourish (muesli's
          waveform-bar spec, matched to our theme). Scoped here so no shared CSS is
          touched; reduced-motion is handled by the global media query. */}
      <style>{`
        @keyframes oat-wave { 0%,100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
      `}</style>
      <button
        type="button"
        onClick={onClick}
        aria-label={noKey ? 'Talk to Michael (needs an OpenAI key)' : `Talk to Michael — ${view.label}`}
        disabled={noKey}
        style={{
          appearance: 'none',
          border: 'none',
          margin: 0,
          padding: 3,
          background: 'var(--cth-paper-100)',
          // The state ring: a crisp pixel border that recolors per pose, plus the
          // classic 2px offset drop shadow so the puck still reads as a button.
          boxShadow: `inset 0 0 0 2px ${active && !noKey ? view.ring : 'var(--cth-ink-900)'}, 2px 2px 0 0 var(--cth-ink-900)`,
          cursor: noKey ? 'not-allowed' : 'pointer',
          opacity: noKey ? 0.85 : 1,
          lineHeight: 0,
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <SpritePortrait character="michael" scale={scale} />
        {/* Waveform flourish — three bars over the avatar's feet while mic-hot. */}
        {view.wave && !noKey && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              bottom: 4,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'inline-flex',
              alignItems: 'flex-end',
              gap: 2,
              height: 12,
              padding: '0 2px',
              background: 'var(--cth-ink-900)',
              boxShadow: `0 0 0 1px var(--cth-ink-900)`
            }}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 2,
                  height: 10,
                  transformOrigin: 'bottom',
                  background: view.ring,
                  animation: `oat-wave ${520 + i * 140}ms steps(3, end) infinite`
                }}
              />
            ))}
          </span>
        )}
        {/* Live-state indicator dot, top-right — color + animation reflect the pose.
            Hidden when off (nothing to signal) and when no key (inert). */}
        {active && !noKey && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 6,
              height: 6,
              background: view.ring,
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              animation: view.dotAnim
            }}
          />
        )}
      </button>
      {!compact && (
        <span
          style={{
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 10,
            lineHeight: '14px',
            marginLeft: 6,
            color: 'var(--cth-ink-900)',
            whiteSpace: 'nowrap'
          }}
        >
          {noKey ? 'talk' : view.label}
        </span>
      )}
      {/* Discoverable, non-blocking cue for WHY the click won't connect without a
          key (the native tooltip is hover-only). Only when no OpenAI key is set;
          the store signal flips and this disappears once a key is added. Dictation
          still works without it (Groq key), so this speaks only to the click. */}
      {noKey && (
        <span
          aria-label="Talk needs an OpenAI key"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 10,
            lineHeight: '14px',
            padding: '1px 5px 0',
            background: 'var(--cth-lemon)',
            color: 'var(--cth-ink-900)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
            flexShrink: 0
          }}
        >
          {compact ? 'needs OpenAI key' : 'needs OpenAI key · Settings'}
        </span>
      )}
    </span>
  );
}
