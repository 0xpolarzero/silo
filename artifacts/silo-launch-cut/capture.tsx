import React from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import { ApplicationPreview } from '@/fixtures/application-preview'
import { applicationSourceForScenario } from '@/fixtures/application-scenarios'
import { SettingsProvider } from '@/features/preferences/settings-store'

const source = applicationSourceForScenario('complete')
source.secrets = [{ id: 'api', name: 'API_KEY', workspaces: ['dev'], allowedDomains: ['api.example.com'], state: 'active' }]
source.workspaces.forEach(w => { w.secretNames = w.machine.name === 'dev' ? ['API_KEY'] : []; w.machine.desktop = true })
const remote = { id: 'studio', name: 'Studio Linux', address: 'studio.local', connected: true }
source.remoteComputers = [remote]
source.workspaces[2].machine.name = 'lab'
source.workspaces[2].computer = { ...remote, vmId: source.workspaces[2].machine.id }
source.workspaces[2].machine.id = 'silo-remote:studio:' + source.workspaces[2].machine.id
source.github.workspaces = source.github.workspaces.slice(0, 2).map(w => ({ ...w, repositories: w.repositories.map(r => ({ ...r, allowPushes: false })) }))
source.preferences.theme = 'dark'
document.documentElement.classList.add('dark')
const scene = new URLSearchParams(location.search).get('scene') || 'overview'
const route = ['github', 'secrets', 'backup'].includes(scene) ? { tab: scene } : { tab: 'workspaces', workspaceSection: scene }
createRoot(document.getElementById('root')!).render(<SettingsProvider initialSettings={source.preferences}><ApplicationPreview source={source} initialRoute={route as any} /></SettingsProvider>)
