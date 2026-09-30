import { vi } from "vitest"
import type { ApplicationActions } from "@/features/application/model/application-source"

/** Fresh, typed action spies for each render; optional capabilities stay explicit. */
export function createApplicationActionsMock(overrides: Partial<ApplicationActions> = {}) {
  return {
    saveSecret: vi.fn<NonNullable<ApplicationActions["saveSecret"]>>(),
    removeSecret: vi.fn<NonNullable<ApplicationActions["removeSecret"]>>(),
    retryRuntimeChecks: vi.fn<NonNullable<ApplicationActions["retryRuntimeChecks"]>>(),
    saveMachineConfiguration: vi.fn<NonNullable<ApplicationActions["saveMachineConfiguration"]>>(),
    dismissMachineConfigurationError: vi.fn<NonNullable<ApplicationActions["dismissMachineConfigurationError"]>>(),
    retryMachineConfiguration: vi.fn<NonNullable<ApplicationActions["retryMachineConfiguration"]>>(),
    pushRepository: vi.fn<NonNullable<ApplicationActions["pushRepository"]>>(),
    startWorkspace: vi.fn<NonNullable<ApplicationActions["startWorkspace"]>>(),
    stopWorkspace: vi.fn<NonNullable<ApplicationActions["stopWorkspace"]>>(),
    restartWorkspace: vi.fn<NonNullable<ApplicationActions["restartWorkspace"]>>(),
    dismissWorkspaceError: vi.fn<NonNullable<ApplicationActions["dismissWorkspaceError"]>>(),
    openTerminal: vi.fn<NonNullable<ApplicationActions["openTerminal"]>>(),
    openEditor: vi.fn<NonNullable<ApplicationActions["openEditor"]>>(),
    connectGitHub: vi.fn<NonNullable<ApplicationActions["connectGitHub"]>>(),
    cancelGitHubConnection: vi.fn<NonNullable<ApplicationActions["cancelGitHubConnection"]>>(),
    reopenGitHubAuthorization: vi.fn<NonNullable<ApplicationActions["reopenGitHubAuthorization"]>>(),
    disconnectGitHub: vi.fn<NonNullable<ApplicationActions["disconnectGitHub"]>>(),
    setGitHubAccessEnabled: vi.fn<NonNullable<ApplicationActions["setGitHubAccessEnabled"]>>(),
    saveGitHubConfiguration: vi.fn<NonNullable<ApplicationActions["saveGitHubConfiguration"]>>(),
    retryGitHubConfiguration: vi.fn<NonNullable<ApplicationActions["retryGitHubConfiguration"]>>(),
    retryGitHubRepositoryCatalog: vi.fn<NonNullable<ApplicationActions["retryGitHubRepositoryCatalog"]>>(),
    ...overrides,
  } satisfies ApplicationActions
}
