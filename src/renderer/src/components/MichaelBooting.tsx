import { PixelPanel } from '@/components/PixelPanel';
import { useStore } from '@/store/store';
import { godForTheme } from '@/scene/office/cast';

/**
 * Loader shown on the empty floor while the god agent is clocking in on launch.
 * Replaces the "add agent" prompt so a returning user doesn't see the empty-floor
 * call-to-action before the orchestrator has booted.
 *
 * This is the FIRST thing rendered after a hive is opened, so it names the
 * orchestrator from the active theme — a castle whose loader said "Michael" gave
 * the theme away before the floor had even drawn.
 */
export function MichaelBooting() {
  const officeTheme = useStore((s) => s.officeTheme);
  const god = godForTheme(officeTheme);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none'
    }}>
      <div style={{ pointerEvents: 'auto', width: 360 }}>
        <PixelPanel variant="dialog" title="CLOCKING IN" noPadding>
          <div style={{
            padding: 20,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14
          }}>
            {/* Stepped pixel blocks — staggered blink, no easing (matches aesthetic) */}
            <div style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 14, height: 14,
                    background: '#6E1423',
                    boxShadow: 'var(--cth-shadow-hard)',
                    animation: 'cth-blink 1s steps(1, end) infinite',
                    animationDelay: `${i * 0.2}s`
                  }}
                />
              ))}
            </div>
            <p style={{
              margin: 0, fontSize: 13, lineHeight: '20px', textAlign: 'center',
              color: 'var(--cth-ink-700)'
            }}>
              {god.displayName} is settling in and getting the floor ready.
              Hang tight…
            </p>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
