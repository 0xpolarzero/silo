import { applicationSourceForScenario } from '@/fixtures/application-scenarios'
import { fixtureDirectoryLoader } from '@/fixtures/directory-loader'
import { remoteWorkspaceTarget, workspaceTarget } from '@/features/application/model/remote-computers'
import type { ApplicationFileEntry, ApplicationSource } from '@/features/application/model/application-source'

const folder = (name: string, names: string[]): ApplicationFileEntry => ({ name, kind: 'folder', children: names.map(name => ({ name, kind: name.includes('.') ? 'file' : 'folder' })) })
const base = applicationSourceForScenario('complete')
const studio = { id: 'studio', name: 'Studio Mac', address: 'developer@studio.local', connected: true }
export const showcaseSource: ApplicationSource = {
  ...base,
  remoteComputers: [studio],
  secrets: base.secrets.map(secret => ({ ...secret, state: 'active' })),
  preferences: { ...base.preferences, editor: 'Zed', terminal: 'Ghostty', reduceMotion: true },
  workspaces: base.workspaces.map((workspace, index) => {
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
    return { ...workspace, machine: { ...workspace.machine, name, id: remote ? remoteWorkspaceTarget(studio.id, workspace.machine.id) : workspace.machine.id },
      ...(remote ? { computer: { ...studio, vmId: workspace.machine.id } } : {}),
      state: 'running' as const, stateDetail: 'Running', freshness: 'fresh' as const, repositories, files, attention: undefined,
    }
  }),
}
// The stock fixture loader keys local workspaces by name; map remote targets too.
export const showcaseDirectoryLoader = fixtureDirectoryLoader(showcaseSource.workspaces.map(workspace => ({ ...workspace, machine: { ...workspace.machine, name: workspaceTarget(workspace) } })))

// Match the GitHub policies to the showcase's renamed local sandboxes.
showcaseSource.github = {
  ...showcaseSource.github,
  account: 'demo-user',
  hostIdentity: { name: 'Demo User', email: 'demo@example.com' },
  workspaces: [
    { workspace: 'web', identity: { name: 'Demo User', email: 'demo@example.com', apply: true }, repositories: [{ repository: 'example/web-app', allowPushes: true }, { repository: 'example/design-system', allowPushes: false }] },
    { workspace: 'services', identity: { name: 'Demo User', email: 'demo@example.com', apply: true }, repositories: [{ repository: 'example/api', allowPushes: true }] },
  ],
}

showcaseSource.sshAccess = { workspaces: showcaseSource.workspaces.map(workspace => ({
  workspace: workspaceTarget(workspace), enabled: true, port: 2222,
  bindAddress: workspace.computer ? '192.168.1.42' : '127.0.0.1', keys: [],
  state: 'listening', message: null, fingerprint: null,
  computerName: workspace.computer?.name ?? 'This computer',
  addresses: ['127.0.0.1', '192.168.1.42'],
})) }
