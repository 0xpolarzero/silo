import type { ApplicationActions, ApplicationSource, ApplicationWorkspace } from '@/features/application/model/application-source';
import type { BackupController } from '@/features/application/model/backup-source';
import { fixtureLogPage, logIdentity } from '@/features/application/model/logs';
import { remoteWorkspaceTarget, workspaceTarget } from '@/features/application/model/remote-computers';
import { applicationSourceForScenario } from '@/fixtures/application-scenarios';
import { fixtureDirectoryLoader } from '@/fixtures/directory-loader';

const fixture = applicationSourceForScenario('complete');
const office = { id: 'demo-office', name: 'Office Mac', address: 'demo@office-mac.local', connected: true };
const workspaces: ApplicationWorkspace[] = fixture.workspaces.map((workspace, index) => index === 2 ? {
  ...workspace,
  computer: { ...office, vmId: workspace.machine.id },
  machine: { ...workspace.machine, id: remoteWorkspaceTarget(office.id, workspace.machine.id) },
  state: 'running' as const,
  stateDetail: 'Running',
} : { ...workspace, machine: { ...workspace.machine, ...(index === 0 ? { desktop: { startWithSandbox: true } } : {}) } });

export const demoSource: ApplicationSource = {
  ...fixture,
  workspaces,
  sshAccess: { workspaces: workspaces.map((workspace, index) => ({
    workspace: workspaceTarget(workspace), enabled: index !== 1,
    port: 2222 + index, bindAddress: workspace.computer ? '192.168.1.42' : '127.0.0.1',
    keys: [], state: index === 1 ? 'disabled' as const : 'listening' as const,
    message: null, fingerprint: null,
    computerName: workspace.computer?.name ?? 'This computer',
    addresses: ['127.0.0.1', workspace.computer ? '192.168.1.42' : '192.168.1.20'],
  })) },
  remoteComputers: [office],
  remoteManagement: { enabled: false, hostId: 'demo-laptop', name: 'My laptop', address: 'demo@laptop.local' },
  preferences: { ...fixture.preferences, reduceMotion: false },
  secrets: fixture.secrets.map(secret => ({ ...secret, state: 'active' })),
  network: { workspaces: workspaces.map(workspace => ({
    workspace: workspaceTarget(workspace), error: null,
    ports: workspace.ports.map(port => ({
      port: port.port, hostPort: port.hostPort ?? port.port, scheme: 'http' as const,
      state: port.listening ? 'reachable' as const : 'waiting' as const, configured: true,
    })),
  })) },
};

/** No live source, native commands, storage, clipboard, or external requests. */
export function readOnlyOperation(): never {
  throw new Error('This website demo is read-only.');
}
const directories = fixtureDirectoryLoader(workspaces);
export const demoActions: ApplicationActions = {
  openDesktop: readOnlyOperation,
  readWorkspaceStorage: async () => ({
    workspaceHostBytes: 18 * 1024 ** 3, runtimeHostBytes: 4 * 1024 ** 3,
    workspaceUsedBytes: 12 * 1024 ** 3, workspaceCapacityBytes: 64 * 1024 ** 3,
    lastReclaimedBytes: 2 * 1024 ** 3, lastTrimAt: 1789941600, lastError: null,
    history: [{ at: 1789941600, trigger: 'scheduled', reclaimedBytes: 2 * 1024 ** 3, error: null }],
  }),
  saveSecret: readOnlyOperation, removeSecret: readOnlyOperation,
  retryRuntimeChecks: readOnlyOperation, saveMachineConfiguration: readOnlyOperation,
  retryMachineConfiguration: readOnlyOperation, pushRepository: readOnlyOperation,
  dismissMachineConfigurationError: readOnlyOperation,
  startWorkspace: readOnlyOperation, stopWorkspace: readOnlyOperation,
  restartWorkspace: readOnlyOperation, dismissWorkspaceError: readOnlyOperation,
  openTerminal: readOnlyOperation, openEditor: readOnlyOperation,
  connectComputer: readOnlyOperation, removeComputer: readOnlyOperation,
  setRemoteManagement: readOnlyOperation, saveRemoteMachine: readOnlyOperation,
  openNetworkPort: readOnlyOperation, saveNetworkPort: readOnlyOperation,
  removeNetworkPort: readOnlyOperation, connectGitHub: readOnlyOperation,
  disconnectGitHub: readOnlyOperation, saveGitHubConfiguration: readOnlyOperation,
  setGitHubAccessEnabled: readOnlyOperation,
  listWorkspaceDirectory: (target, path, offset) => directories(
    workspaces.find(workspace => workspaceTarget(workspace) === target)?.machine.name ?? target,
    path, offset,
  ),
  queryLogs: async request => {
    const workspace = workspaces.find(item => {
      const identity = logIdentity(item);
      return identity.sandboxId === request.sandboxId && identity.computerId === request.computerId;
    });
    if (!workspace) throw new Error('Unknown demo sandbox');
    return fixtureLogPage(workspace, request);
  },
};

export const demoBackup: BackupController = {
  state: {
    snapshotId: 'website-sample', availability: 'available', availableSpaceGB: 250,
    destination: fixture.backup.destination, operation: null,
    archives: [{
      name: fixture.backup.lastArchive, archivePath: '/sample/backups/development.silo-backup',
      completedLabel: fixture.backup.completedLabel, size: fixture.backup.compressedSize,
      destination: fixture.backup.destination, sandboxes: ['dev', 'playgrounds'],
    }],
  },
  actions: {
    chooseDestination: readOnlyOperation, chooseArchive: readOnlyOperation,
    inspectArchive: readOnlyOperation, startBackup: readOnlyOperation,
    startRestore: readOnlyOperation, cancelOperation: readOnlyOperation,
    retryStart: readOnlyOperation, dismissOperation: readOnlyOperation,
  },
};
