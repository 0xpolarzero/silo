import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { FixtureApp } from './fixtures/fixture-app'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { DesktopStatusFixture } from './fixtures/desktop-fixtures'

const statusPanel = isTauri() && getCurrentWindow().label === 'status'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {statusPanel ? <DesktopStatusFixture /> : <FixtureApp />}
  </StrictMode>,
)
