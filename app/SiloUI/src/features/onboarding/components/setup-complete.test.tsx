import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import {
  createSystemIntegrationStore,
  SystemIntegrationProvider,
  type SystemIntegrationService,
  type SystemIntegrations,
} from "@/features/preferences/system-integrations-store"
import { SetupComplete } from "./setup-complete"

function view(runtime: SystemIntegrations) {
  const settings = createMemorySettingsStore({
    launchAtLogin: true,
    startWorkspacesAtLaunch: true,
    notificationsEnabled: true,
  })
  const service: SystemIntegrationService = {
    read: vi.fn(async () => runtime),
    setLoginItem: vi.fn(),
    requestNotifications: vi.fn(),
    openSettings: vi.fn(async () => {}),
    showError: vi.fn(async () => {}),
  }
  const integrations = createSystemIntegrationStore(service, settings, runtime)
  render(<SettingsProvider store={settings}>
    <SystemIntegrationProvider store={integrations}>
      <SetupComplete machines={productionMachineDefaults} githubSummary="GitHub connected" />
    </SystemIntegrationProvider>
  </SettingsProvider>)
  return service
}

describe("completed onboarding system controls", () => {
  it("hides login children until the OS is enabled and approved", () => {
    view({
      platform: "macos",
      loginItem: { state: "requiresApproval", error: null },
      notifications: { state: "authorized", error: null },
    })

    expect(screen.getByRole("switch", { name: "Launch Silo at login" })).not.toBeChecked()
    expect(screen.queryByRole("switch", { name: "Start sandboxes at launch" })).not.toBeInTheDocument()
    expect(screen.getByText("Approval required")).toBeVisible()
    expect(screen.getByRole("button", { name: "Open System Settings" })).toBeVisible()
  })

  it("hides notification categories after denial even when the saved preference was true", () => {
    view({
      platform: "macos",
      loginItem: { state: "enabled", error: null },
      notifications: { state: "denied", error: null },
    })

    expect(screen.getByRole("switch", { name: "Enable notifications" })).not.toBeChecked()
    expect(screen.queryByRole("switch", { name: "Sandbox health" })).not.toBeInTheDocument()
    expect(screen.getByText("Blocked in System Settings")).toBeVisible()
  })

  it("keeps unavailable integrations disabled with all dependent controls hidden", () => {
    view({
      platform: "linux",
      loginItem: { state: "unavailable", error: null },
      notifications: { state: "unavailable", error: null },
    })

    expect(screen.getByRole("switch", { name: "Launch Silo at login" })).toBeDisabled()
    expect(screen.getByRole("switch", { name: "Enable notifications" })).toBeDisabled()
    expect(screen.queryByRole("switch", { name: "Start sandboxes at launch" })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: "Sandbox health" })).not.toBeInTheDocument()
  })

  it("shows the approved flat child controls only for verified enabled states", () => {
    view({
      platform: "macos",
      loginItem: { state: "enabled", error: null },
      notifications: { state: "authorized", error: null },
    })

    expect(screen.getByRole("switch", { name: "Launch Silo at login" })).toBeChecked()
    expect(screen.getByRole("switch", { name: "Start sandboxes at launch" })).toBeChecked()
    expect(screen.getByRole("combobox", { name: "Add sandbox at startup" })).toBeVisible()
    expect(screen.getByRole("switch", { name: "Enable notifications" })).toBeChecked()
    expect(screen.getByRole("switch", { name: "Sandbox health" })).toBeVisible()
    expect(screen.queryByText("State changes and failed health checks.")).not.toBeInTheDocument()
  })
})
