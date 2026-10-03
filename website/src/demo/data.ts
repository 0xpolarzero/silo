import type { ApplicationActions, ApplicationComputer, ApplicationSource } from '@/features/application/model/application-source';
import { computerTarget } from '@/features/application/model/connections';
import { fixtureLogPage, logIdentity } from '@/features/application/model/logs';
import { applicationSourceForScenario } from '@/fixtures/application-scenarios';
import { fixtureDirectoryLoader } from '@/fixtures/directory-loader';

const fixture = applicationSourceForScenario('complete');
const office = { id: 'demo-office', name: 'Office Mac', address: 'demo@office-mac.local', connected: true };
const computers: ApplicationComputer[] = fixture.computers.map((computer, index) => index === 2 ? {
  ...computer,
  device: { ...office, computerId: computer.configuration.id },
  state: 'running' as const,
  stateDetail: 'Running',
} : { ...computer, configuration: { ...computer.configuration, ...(index === 0 ? { desktop: { startWithComputer: true } } : {}) } });

export const demoSource: ApplicationSource = {
  ...fixture,
  computers,
  sshAccess: { computers: computers.map((computer, index) => ({
    computer: computerTarget(computer), enabled: index !== 1,
    port: 2222 + index, bindAddress: computer.device ? '192.168.1.42' : '127.0.0.1',
    keys: [], state: index === 1 ? 'disabled' as const : 'listening' as const,
    message: null, fingerprint: null,
    deviceName: computer.device?.name ?? 'This device',
    addresses: ['127.0.0.1', computer.device ? '192.168.1.42' : '192.168.1.20'],
  })) },
  devices: [office],
  connections: { enabled: false, deviceId: 'demo-laptop', name: 'My laptop', address: 'demo@laptop.local' },
  preferences: { ...fixture.preferences, reduceMotion: false },
  secrets: fixture.secrets.map(secret => ({ ...secret, state: 'active' })),
  network: { computers: computers.map(computer => ({
    computer: computerTarget(computer), error: null,
    ports: computer.ports.map(port => ({
      port: port.port, hostPort: port.hostPort ?? port.port, scheme: 'http' as const,
      state: port.listening ? 'reachable' as const : 'waiting' as const, configured: true,
    })),
  })) },
};

/** No live source, native commands, storage, clipboard, or external requests. */
export function readOnlyOperation(): never {
  throw new Error('This website demo is read-only.');
}
const directories = fixtureDirectoryLoader(computers);
export const demoActions: ApplicationActions = {
  openDesktop: readOnlyOperation,
  readWorkspaceStorage: async () => ({
    workspaceHostBytes: 18 * 1024 ** 3, runtimeHostBytes: 4 * 1024 ** 3,
    checkpointHostBytes: 0, checkpointCount: 0,
    workspaceUsedBytes: 12 * 1024 ** 3, workspaceCapacityBytes: 64 * 1024 ** 3,
    lastReclaimedBytes: 2 * 1024 ** 3, lastTrimAt: 1789941600, lastError: null,
    history: [{ at: 1789941600, trigger: 'scheduled', reclaimedBytes: 2 * 1024 ** 3, error: null }],
  }),
  saveSecret: readOnlyOperation, removeSecret: readOnlyOperation,
  retryRuntimeChecks: readOnlyOperation, saveComputerConfiguration: readOnlyOperation,
  retryComputerConfiguration: readOnlyOperation, pushRepository: readOnlyOperation,
  dismissComputerConfigurationError: readOnlyOperation,
  startComputer: readOnlyOperation, stopComputer: readOnlyOperation,
  restartComputer: readOnlyOperation, dismissComputerError: readOnlyOperation,
  openTerminal: readOnlyOperation, openEditor: readOnlyOperation,
  connectDevice: readOnlyOperation, removeDevice: readOnlyOperation,
  setConnectionsEnabled: readOnlyOperation, saveRemoteComputer: readOnlyOperation,
  openNetworkPort: readOnlyOperation, saveNetworkPort: readOnlyOperation,
  removeNetworkPort: readOnlyOperation, connectGitHub: readOnlyOperation,
  disconnectGitHub: readOnlyOperation, saveGitHubConfiguration: readOnlyOperation,
  setGitHubAccessEnabled: readOnlyOperation,
  listComputerDirectory: (target, path, offset) => directories(target, path, offset),
  queryLogs: async request => {
    const computer = computers.find(item => {
      const identity = logIdentity(item);
      return identity.deviceId === request.deviceId && identity.computerId === request.computerId;
    });
    if (!computer) throw new Error('Unknown demo computer');
    return fixtureLogPage(computer, request);
  },
};
