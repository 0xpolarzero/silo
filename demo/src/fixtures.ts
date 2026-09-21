import type {
  ApplicationActions,
  ApplicationSource,
  ApplicationWorkspace,
} from "@/features/application/model/application-source";
import { remoteWorkspaceTarget } from "@/features/application/model/remote-computers";
import { fixtureMachineDefaults } from "@/fixtures/machine-configurations";

export const noop = () => undefined;
const resolved = async () => undefined;
// Deliberately inert. No production source, native commands, SSH, or network I/O.
export const actions: ApplicationActions = {
  saveSecret: noop,
  removeSecret: noop,
  retryRuntimeChecks: noop,
  saveMachineConfiguration: noop,
  retryMachineConfiguration: noop,
  dismissMachineConfigurationError: noop,
  pushRepository: noop,
  startWorkspace: noop,
  stopWorkspace: noop,
  dismissWorkspaceError: noop,
  restartWorkspace: noop,
  openTerminal: noop,
  openEditor: noop,
  connectComputer: resolved,
  removeComputer: resolved,
  setRemoteManagement: resolved,
  saveRemoteMachine: resolved,
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
export const demoMachine = {
  ...fixtureMachineDefaults[0],
  id: "00000000-0000-4000-8000-000000000010",
  name: "demo",
  cpus: 4,
  maxCPUs: 8,
  memoryGiB: 8,
  maxMemoryGiB: 16,
  workspaceStorageGiB: 40,
  runtimeStorageGiB: 20,
};
export const target = remoteWorkspaceTarget(office.id, demoMachine.id);
function workspace(
  name: string,
  remote: boolean,
  id: string,
): ApplicationWorkspace {
  return {
    machine: {
      ...demoMachine,
      name,
      id: remote ? remoteWorkspaceTarget(office.id, id) : id,
    },
    ...(remote ? { computer: { ...office, vmId: id } } : {}),
    purpose: remote ? "Development on Office Mac" : "Local development",
    state: "running",
    stateDetail: "Running",
    freshness: "fresh",
    host: `${name}.silo.test`,
    repositories: [],
    files: [],
    ports: [],
    logs: [],
    githubRepositories: [],
    secretNames: [],
  };
}
export const local = workspace(
  "personal",
  false,
  "00000000-0000-4000-8000-000000000011",
);
export const remote = workspace(
  "web",
  true,
  "00000000-0000-4000-8000-000000000012",
);
export const demo = workspace("demo", true, demoMachine.id);
export function sourceFor({
  connected = true,
  created = false,
  enabled = false,
  starting = false,
  portConnected = true,
} = {}): ApplicationSource {
  return {
    remoteComputers: connected ? [office] : [],
    remoteManagement: {
      enabled,
      hostId: "local-host",
      name: enabled ? office.name : "My laptop",
      address: office.address,
    },
    workspaces: [
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
    sandboxConfigurationOperation: null,
    repositoryPushOperations: [],
    github: { state: "disconnected", workspaces: [] },
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
      startWorkspacesAtLaunch: false,
      reduceMotion: true,
    },
    network: {
      workspaces: [
        {
          workspace: target,
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
