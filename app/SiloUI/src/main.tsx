import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { FixtureApp } from './fixtures/fixture-app'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FixtureApp />
  </StrictMode>,
)
