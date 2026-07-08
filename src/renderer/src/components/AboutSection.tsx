/** OAT-4 — About section: app identity + version, what munder-difflin is, and
 *  the muesli MIT attribution (we port muesli's capabilities/UX; the Pomodoro +
 *  meeting/dictation work draws on it — MIT requires the notice when we lift
 *  verbatim assets, and we credit it regardless). */

const headerStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
};
const bodyStyle: React.CSSProperties = {
  margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)'
};

export function AboutSection() {
  const version = (window.cth as { version?: string }).version ?? '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 16, lineHeight: '22px',
          color: 'var(--cth-ink-900)', letterSpacing: 1
        }}>
          MUNDER DIFFLIN
        </div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-mono, monospace)' }}>
          v{version}
        </div>
      </div>

      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

      <div>
        <div style={headerStyle}>What is this</div>
        <p style={bodyStyle}>
          A desktop harness for running a whole office of Claude agents — a pixel-art
          floor where each agent has its own terminal, memory, and role, coordinated
          by Michael the orchestrator. Spin up a team, hand them work, and watch it
          get done.
        </p>
      </div>

      <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />

      <div>
        <div style={headerStyle}>Credits</div>
        <p style={bodyStyle}>
          Voice, meeting, and focus-timer capabilities draw on{' '}
          <strong>muesli</strong> (local-first dictation &amp; meeting notes).
        </p>
        <p style={{ ...bodyStyle, marginTop: 8, fontSize: 12, color: 'var(--cth-ink-500)' }}>
          muesli is MIT-licensed. Copyright &copy; 2026 Pranav Hari —{' '}
          <span style={{ fontFamily: 'var(--cth-font-mono, monospace)' }}>github.com/Muesli-HQ/muesli</span>.
          Used under the terms of the MIT License.
        </p>
      </div>
    </div>
  );
}
