import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it } from "vitest"

import type { ApplicationGitHubConfiguration } from "@/features/application/model/application-source"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"
import { onboardingScenarios } from "@/fixtures/scenarios"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { assertNativeBridgeMocksHandled, nativeBridgeMock } from "@/test/native-bridge-mock"
import { ProductionOnboarding } from "./production-onboarding"
import { createProductionSource, useProductionSource, type ProductionBridge, type ProductionSource } from "./production-source"

afterEach(assertNativeBridgeMocksHandled)

function Setup({ source }: { source: ProductionSource }) {
  const snapshot = useProductionSource(source)
  return <ProductionOnboarding source={source} application={snapshot.source} dependencies={{ checks: onboardingScenarios.complete.preflightChecks, retry: () => {} }} />
}

it.each(["connected", "disconnected"] as const)("keeps token policy through the real onboarding save bridge and completion with OAuth %s", async (oauthState) => {
  const user = userEvent.setup()
  const live = applicationSourceForScenario("running", oauthState)
  live.workspaces = [live.workspaces[0]]
  const policy = { ...live.github.workspaces![0], authenticationMethod: "token" as const, repositoryMode: "selected" as const, allRepositoriesAllowChanges: false }
  live.github = { ...live.github, personalToken: { state: "connected", saved: true }, workspaces: [policy], policyRevision: 10 }
  const invoke = nativeBridgeMock({
    read_application_state: () => structuredClone(live),
    read_backup_state: () => ({ snapshotId: "test", availability: "available", archives: [], operation: null }),
    read_setup_activity: () => [],
    read_network_state: () => ({ workspaces: [] }),
    remote_network_state: () => ({ workspaces: [] }),
    remote_host_list: () => [],
    remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "developer@laptop" }),
    read_operation_queue: () => ({ running: [], waiting: [] }),
    verify_workspace_identities: () => true,
    configure_workspace_identities: () => undefined,
    save_github_configuration: (args) => {
      const configuration = args!.configuration as ApplicationGitHubConfiguration
      live.github = { ...live.github, policyRevision: 11, workspaces: configuration.workspaces,
        workspaceOperations: [{ workspace: "dev", status: "succeeded", message: "Applied" }] }
      return structuredClone(live.github)
    },
  })
  const source = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  await source.initialize()
  const settings = createMemorySettingsStore()
  const integrations = createFixtureSystemIntegrationStore(settings)
  const view = render(<SettingsProvider store={settings}><SystemIntegrationProvider store={integrations}><Setup source={source} /></SystemIntegrationProvider></SettingsProvider>)
  try {
    await user.click(screen.getByRole("tab", { name: /GitHub/ }))
    expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Use token for dev" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_github_configuration", {
      configuration: { baseRevision: 10, hostIdentity: live.github.hostIdentity ?? null, workspaces: [policy] },
    }))
    expect(source.getSnapshot().source?.github.workspaces).toEqual([policy])
    if (oauthState === "disconnected") {
      expect(screen.getByRole("group", { name: "GitHub access" })).toHaveTextContent("Personal token in 1 sandbox")
      expect(screen.getByRole("group", { name: "GitHub access" })).not.toHaveTextContent("Skipped")
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled())
    await user.click(screen.getByRole("button", { name: "Finish" }))
    await waitFor(() => expect(settings.getSnapshot().settings.onboardingComplete).toBe(true))
    expect(source.getSnapshot().source?.github.workspaces).toEqual([policy])
  } finally {
    view.unmount()
    source.dispose()
  }
})
