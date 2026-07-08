/**
 * Free Flow entry point B — hold-Option-to-talk (the human's chosen activation).
 *
 * Hold the Option (⌥) key ALONE for a short threshold to ARM recording; release
 * to stop and transcribe into the focused agent's composer draft (same path as
 * the mic button — review before send). Active only while Free Flow is enabled.
 *
 * The hard part is the TERMINAL Alt/Meta conflict: in a terminal Option is Meta
 * (Alt+key combos, special chars), so a naive "Option is down → record" would
 * clobber normal input. Disambiguation:
 *   - A solo-hold THRESHOLD (~320ms): Option must be held alone, with no other
 *     key, before recording arms. A quick Alt+key combo never reaches it.
 *   - ABORT the instant any other key joins while Option is down (and before
 *     recording armed) — it's a real Alt combo; we never call preventDefault, so
 *     the terminal/composer sees the keystroke untouched.
 *   - Auto-repeat keydowns (e.repeat) are ignored so a held Option doesn't re-arm.
 *   - Listeners are CAPTURE-phase on window, so the gesture still fires while
 *     xterm (or the composer textarea) holds DOM focus.
 *   - We never preventDefault, so when not recording, Option behaves exactly as
 *     before for terminals and text fields.
 *
 * Scope: works app-wide while the window is focused (covers any agent's terminal
 * screen per the requirement). Target = the fullscreen agent, else the selected
 * agent. A window blur resets state so a release missed off-window can't strand a
 * recording.
 */
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import type { DictationHotkey } from '@/store/config';
import { freeflowRecorder } from './recorder';

/** How long the modifier must be held ALONE before recording arms. Long enough
 *  that a normal modifier+key combo (which disqualifies immediately) never trips
 *  it. */
const ARM_MS = 320;

/** True when `e` is the physical modifier the configured dictation hotkey names.
 *  V1 keeps the terminal-safe solo-hold gesture and only makes WHICH modifier
 *  configurable ('Alt' = the original hold-Option ⌥). */
function matchesHotkey(e: KeyboardEvent, hk: DictationHotkey): boolean {
  switch (hk) {
    case 'Control':
      return e.code === 'ControlLeft' || e.code === 'ControlRight' || e.key === 'Control';
    case 'Meta':
      return e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta';
    case 'Alt':
    default:
      return e.code === 'AltLeft' || e.code === 'AltRight' || e.key === 'Alt' || e.key === 'AltGraph';
  }
}

/** Install the hold-Option-to-talk gesture for as long as the component is
 *  mounted. Reads enablement + the focused agent from the store live. */
export function useHoldOptionToTalk(): void {
  useEffect(() => {
    let optionDown = false;     // the hotkey modifier physically held right now
    let activeHotkey: DictationHotkey = 'Alt'; // locked in at keydown for the keyup match
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    let recording = false;      // THIS gesture started a recording
    let disqualified = false;   // another key joined → treat as a normal modifier combo

    const focusedAgentId = (): string | null => {
      const s = useStore.getState();
      return s.fullscreenAgentId ?? s.selectedId;
    };

    const clearArm = (): void => {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };

    const reset = (): void => {
      clearArm();
      if (recording) freeflowRecorder.stop();
      optionDown = false;
      recording = false;
      disqualified = false;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      // Only active when Free Flow is on. Read the configured modifier LIVE so a
      // Settings change takes effect without a remount.
      const s = useStore.getState();
      if (!s.freeflowEnabled) return;
      const hk = s.dictationHotkey ?? 'Alt';

      if (matchesHotkey(e, hk)) {
        if (e.repeat || optionDown) return; // ignore auto-repeat / already tracking
        activeHotkey = hk;                  // remember it for the matching keyup
        optionDown = true;
        disqualified = false;
        // Don't start a second capture if one is already running/uploading.
        if (freeflowRecorder.isBusy()) { disqualified = true; return; }
        const target = focusedAgentId();
        if (!target) { disqualified = true; return; }
        clearArm();
        armTimer = setTimeout(() => {
          armTimer = null;
          if (optionDown && !disqualified) {
            recording = true;
            void freeflowRecorder.start(target);
          }
        }, ARM_MS);
        return;
      }

      // Any non-hotkey key while the modifier is held, BEFORE recording armed, means
      // a real combo (or plain typing) — disqualify and let it pass untouched.
      if (optionDown && !recording) {
        disqualified = true;
        clearArm();
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      // Match the SAME modifier that started the hold (activeHotkey), so a mid-hold
      // Settings change can't strand a recording — blur also resets as a backstop.
      if (!optionDown || !matchesHotkey(e, activeHotkey)) return;
      clearArm();
      if (recording) freeflowRecorder.stop(); // release → transcribe
      optionDown = false;
      recording = false;
      disqualified = false;
    };

    // Capture phase so xterm/textarea focus can't swallow the events first.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', reset);
      reset();
    };
  }, []);
}
