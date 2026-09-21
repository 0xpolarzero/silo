import { useEffect, useState, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { ApplicationPreview } from '@/fixtures/application-preview'
import { SettingsProvider } from '@/features/preferences/settings-store'
import { showcaseSource, showcaseDirectoryLoader } from './showcase-fixtures'
import { ShowcaseDesktop } from './showcase-desktop'
import { SiloMark } from '@/components/silo-mark'
import './app.css'
import './showcase.css'

const params = new URLSearchParams(location.search)
const initialDark = params.get('theme') !== 'light'
document.documentElement.classList.toggle('dark', initialDark)

function ProductShot({ view, label, className }: { view: 'overview' | 'files' | 'github'; label: string; className: string }) {
  const shot = useRef<HTMLElement>(null)
  useEffect(() => {
    if (view !== 'overview') return
    const button = shot.current?.querySelector<HTMLButtonElement>('button[aria-label="SSH controls for lab"]')
    if (button?.getAttribute('aria-expanded') === 'false') button.click()
  }, [view])
  return <section ref={shot} className={`showcase-shot ${className}`} aria-label={label}>
    <span className="showcase-shot-label">{label}</span>
    <div className="showcase-product">
      <SettingsProvider initialSettings={showcaseSource.preferences}>
        <ApplicationPreview source={showcaseSource} initialRoute={view === 'github' ? { tab: 'github' } : { tab: 'workspaces', workspaceSection: view }} actions={{ listWorkspaceDirectory: showcaseDirectoryLoader }} />
      </SettingsProvider>
    </div>
  </section>
}

export function Showcase() {
  const [dark, setDark] = useState(initialDark)
  const capture = params.get('capture') === '1'
  const fit = () => capture ? 1 : Math.max(.15, Math.min(1, (window.innerWidth - 48) / 1600, (window.innerHeight - 116) / 1100))
  const [scale, setScale] = useState(fit)
  useEffect(() => { const resize = () => setScale(fit()); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [capture])
  return <div className="showcase-workbench">
    <div className="showcase-canvas" style={{ width: 1600 * scale, height: 1100 * scale }}><div className="showcase-frame" style={{ transform: `scale(${scale})` }}>
      <div className="showcase-atmosphere" aria-hidden="true" />
      <header className="showcase-heading">
        <div className="showcase-brand"><SiloMark aria-hidden="true" /><span>Silo</span></div>
        <span className="showcase-eyebrow">Available on macOS and Linux</span>
        <h1>Give your agents<br/>a computer<br/><span>of their own.</span></h1>
        <p>Linux VMs running locally or remotely,<br/>with a desktop and computer use.</p>
      </header>
      <ShowcaseDesktop />
      <ProductShot view="overview" label="Manage local and remote sandboxes" className="showcase-overview" />
      <ProductShot view="github" label="Set fine-grained GitHub permissions per sandbox" className="showcase-github" />
    </div></div>
    {!capture && <footer className="showcase-tools" aria-label="Showcase controls">
      <span>GitHub hero · Draft 03</span>
      <button onClick={() => {document.documentElement.classList.toggle('dark', !dark); setDark(!dark)}}>{dark ? 'Light appearance' : 'Dark appearance'}</button>
      <span className="showcase-note">Production Silo UI · Illustrated Linux desktop · Illustrated agent task</span>
    </footer>}
  </div>
}
createRoot(document.getElementById('root')!).render(<Showcase />)
