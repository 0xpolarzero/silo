import { LinuxDesktopViewer } from '@/desktop/linux-desktop-viewer'

const noop = () => undefined

/** Production viewer around a illustrated Linux desktop and an illustrated task. */
export function ShowcaseDesktop() {
  return <section className="showcase-shot showcase-desktop" aria-label="Linux desktop with Luda computer use">
    <span className="showcase-shot-label">A Linux desktop your agents can use</span>
    <div className="showcase-desktop-window">
      <LinuxDesktopViewer name="web · Linux desktop" state={{ installed: true, state: 'running', autoStart: true, ludaState: 'ready' }} busy={false} error={null} onAction={noop} onRetry={noop} onFullscreen={noop} />
      <div className="showcase-guest">
        <div className="guest-panel" aria-label="Linux desktop panel"><span>Applications</span><span>web · Linux desktop</span></div>
        <div className="guest-browser">
          <div className="guest-title">Project Hub — Mozilla Firefox <span>−　□　×</span></div>
          <div className="guest-address">←　→　↻ <span>localhost:3000</span></div>
          <div className="guest-site"><small>PROJECT HUB / WORKSPACE</small><h2>Make room for<br/>your next idea.</h2><p>A place for projects to take shape.</p><div className="guest-cta">Create a project <span>↗</span></div><div className="guest-project"><b>Website redesign</b><span>Design · In progress</span><div /></div></div>
        </div>
        <div className="guest-agent">
          <div className="guest-title">Agent terminal <span>−　□　×</span></div>
          <div className="guest-terminal"><small>EXAMPLE AGENT TASK</small><p><span className="terminal-prompt">›</span> Open the app and test<br/>　the project creation flow.</p><div className="terminal-tool">Luda · computer use</div><p className="terminal-step">✓ Observe the Linux desktop<br/>✓ Open localhost:3000<br/>✓ Click “Create a project”</p><p className="terminal-active">● Check the result</p><span className="terminal-caret">▌</span></div>
        </div>
      </div>
    </div>
  </section>
}
