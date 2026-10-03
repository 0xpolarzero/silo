import { applicationSourceForScenario } from '@/fixtures/application-scenarios'
import { fixtureDirectoryLoader } from '@/fixtures/directory-loader'
import { computerTarget } from '@/features/application/model/connections'
import type { ApplicationFileEntry, ApplicationSource } from '@/features/application/model/application-source'

const folder = (name: string, names: string[]): ApplicationFileEntry => ({ name, kind: 'folder', children: names.map(name => ({ name, kind: name.includes('.') ? 'file' : 'folder' })) })
const base = applicationSourceForScenario('complete')
const studio = { id: 'studio', name: 'Studio Mac', address: 'developer@studio.local', connected: true }
export const showcaseSource: ApplicationSource = {
  ...base,
  devices: [studio],
  secrets: base.secrets.map(secret => ({ ...secret, state: 'active' })),
  preferences: { ...base.preferences, editor: 'Zed', terminal: 'Ghostty', reduceMotion: true, alphaNoticeDismissed: true },
  computers: base.computers.map((computer, index) => {
    const remote = index === 2
    const name = ['web', 'services', 'lab'][index]
    const repositories = [
      [{ path: '/workspace/web-app', branch: 'feat/dashboard', ahead: 2, behind: 0, dirty: false }, { path: '/workspace/design-system', branch: 'main', ahead: 0, behind: 0, dirty: false }],
      [{ path: '/workspace/api', branch: 'main', ahead: 0, behind: 0, dirty: false }],
      [{ path: '/workspace/experiments', branch: 'feat/search', ahead: 1, behind: 0, dirty: false }],
    ][index]
    const files = [
      [folder('web-app', ['src', 'public', 'package.json', 'README.md']), folder('design-system', ['components', 'tokens', 'package.json']), { name: 'README.md', kind: 'file' as const }],
      [folder('api', ['src', 'migrations', 'Cargo.toml']), { name: 'compose.yaml', kind: 'file' as const }],
      [folder('experiments', ['notebooks', 'datasets', 'pyproject.toml'])],
    ][index]
    return { ...computer, configuration: { ...computer.configuration, name },
      ...(remote ? { device: { ...studio, computerId: computer.configuration.id } } : {}),
      state: 'running' as const, stateDetail: 'Running', freshness: 'fresh' as const, repositories, files, attention: undefined,
    }
  }),
}
export const showcaseDirectoryLoader = fixtureDirectoryLoader(showcaseSource.computers)

showcaseSource.github = {
  ...showcaseSource.github,
  account: 'demo-user',
  deviceIdentity: { name: 'Demo User', email: 'demo@example.com' },
  computers: [
    { computer: 'web', identity: { name: 'Demo User', email: 'demo@example.com', apply: true }, repositories: [{ repository: 'example/web-app', allowPushes: true }, { repository: 'example/design-system', allowPushes: false }] },
    { computer: 'services', identity: { name: 'Demo User', email: 'demo@example.com', apply: true }, repositories: [{ repository: 'example/api', allowPushes: true }] },
  ],
}

showcaseSource.sshAccess = { computers: showcaseSource.computers.map(computer => ({
  computer: computerTarget(computer), enabled: true, port: 2222,
  bindAddress: computer.device ? '192.168.1.42' : '127.0.0.1', keys: [],
  state: 'listening', message: null, fingerprint: null,
  deviceName: computer.device?.name ?? 'This device',
  addresses: ['127.0.0.1', '192.168.1.42'],
})) }
