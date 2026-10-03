import type {
  ApplicationActions,
  ApplicationSource,
  ApplicationComputer,
} from "@/features/application/model/application-source";
import { remoteComputerTarget } from "@/features/application/model/connections";
import { fixtureComputerDefaults } from "@/fixtures/computer-configurations";

export const noop = () => undefined;
const resolved = async () => undefined;
// Deliberately inert. No production source, native commands, SSH, or network I/O.
export const actions: ApplicationActions = {
  saveSecret: noop,
  removeSecret: noop,
  retryRuntimeChecks: noop,
  saveComputerConfiguration: noop,
  retryComputerConfiguration: noop,
  dismissComputerConfigurationError: noop,
  pushRepository: noop,
  startComputer: noop,
  stopComputer: noop,
  dismissComputerError: noop,
  restartComputer: noop,
  openTerminal: noop,
  openEditor: noop,
  connectDevice: resolved,
  removeDevice: resolved,
  setConnectionsEnabled: resolved,
  saveRemoteComputer: resolved,
  saveNetworkPort: resolved,
  openNetworkPort: resolved,
  removeNetworkPort: resolved,
};
export const office = {
  id: "office-mac",
  name: "Office Mac",
  address: "developer@office-mac.local",
  connected: true,
};
export const demoConfiguration = {
  ...fixtureComputerDefaults[0],
  id: "00000000-0000-4000-8000-000000000010",
  name: "demo",
  cpus: 4,
  maxCPUs: 8,
  memoryGiB: 8,
  maxMemoryGiB: 16,
  workspaceStorageGiB: 40,
  runtimeStorageGiB: 20,
};
export const target = remoteComputerTarget(office.id, demoConfiguration.id);
function computer(
  name: string,
  remote: boolean,
  id: string,
): ApplicationComputer {
  return {
    configuration: { ...demoConfiguration, name, id },
    ...(remote ? { device: { ...office, computerId: id } } : {}),
    purpose: remote ? "Development on Office Mac" : "Local development",
    state: "running",
    stateDetail: "Running",
    freshness: "fresh",
    repositories: [],
    files: [],
    ports: [],
    logs: [],
    githubRepositories: [],
    secretNames: [],
  };
}
export const local = computer(
  "personal",
  false,
  "00000000-0000-4000-8000-000000000011",
);
export const remote = computer(
  "web",
  true,
  "00000000-0000-4000-8000-000000000012",
);
export const demo = computer("demo", true, demoConfiguration.id);
export function sourceFor({
  connected = true,
  created = false,
  enabled = false,
  starting = false,
  portConnected = true,
} = {}): ApplicationSource {
  return {
    devices: connected ? [office] : [],
    connections: {
      enabled,
      deviceId: "local-device",
      name: enabled ? office.name : "My laptop",
      address: office.address,
    },
    computers: [
      local,

      ...(created
        ? [
            {
              ...demo,
              state: starting ? ("stopped" as const) : ("running" as const),
              stateDetail: starting ? "Stopped" : "Running",
            },
          ]
        : []),
    ],
    runtimeRepair: null,
    activities: [],
    computerConfigurationOperation: null,
    repositoryPushOperations: [],
    github: { state: "disconnected", computers: [] },
    secrets: [],
    backup: {
      lastArchive: "",
      completedLabel: "",
      compressedSize: "",
      destination: "",
    },
    preferences: {
      terminal: "Ghostty",
      editor: "Zed",
      browser: "Safari",
      launchAtLogin: false,
      startComputersAtLaunch: false,
      reduceMotion: true,
    },
    network: {
      computers: [
        {
          computer: target,
          error: null,
          ports: [
            {
              port: 5173,
              hostPort: portConnected ? 53124 : null,
              scheme: "http",
              state: portConnected ? "reachable" : "unpublished",
              configured: portConnected,
            },
          ],
        },
      ],
    },
  };
}
