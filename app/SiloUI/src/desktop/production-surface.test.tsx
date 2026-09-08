import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import type { ProductionSource } from "./production-source"
import type { DependencyStore } from "./dependencies"
import { ProductionSurface } from "./production-surface"

vi.mock("./production-source", () => ({ useProductionSource: () => ({ source: {}, backup: {}, loading: false }) }))
vi.mock("./dependencies", () => ({ useDependencyStore: () => ({ checks: [], retry: vi.fn() }) }))
vi.mock("./production-onboarding", () => ({ ProductionOnboarding: ({ onOpenApp }: { onOpenApp: () => void }) => <button onClick={onOpenApp}>Open Silo</button> }))
vi.mock("@/features/application/application-app", () => ({ ApplicationApp: () => <div>Main app</div> }))
vi.mock("./status-panel", () => ({ StatusPanel: () => <div>Status panel</div> }))

const source = { applicationActions: {}, statusActions: {} } as ProductionSource
const dependencyStore = {} as DependencyStore

describe("production completion routing", () => {
  it("keeps onboarding mounted after Finish saves completion until Open Silo", async () => {
    const settings = createMemorySettingsStore()
    render(<SettingsProvider store={settings}><ProductionSurface source={source} dependencyStore={dependencyStore} /></SettingsProvider>)
    expect(screen.getByRole("button", { name: "Open Silo" })).toBeVisible()
    await act(async () => { await settings.updateSettings({ onboardingComplete: true }) })
    expect(screen.getByRole("button", { name: "Open Silo" })).toBeVisible()
    expect(screen.queryByText("Main app")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open Silo" }))
    expect(screen.getByText("Main app")).toBeVisible()
  })

  it("opens the main app when relaunched after saved completion", () => {
    const settings = createMemorySettingsStore({ onboardingComplete: true })
    render(<SettingsProvider store={settings}><ProductionSurface source={source} dependencyStore={dependencyStore} /></SettingsProvider>)
    expect(screen.getByText("Main app")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Open Silo" })).not.toBeInTheDocument()
  })

  it("keeps the status window outside onboarding", () => {
    const settings = createMemorySettingsStore()
    render(<SettingsProvider store={settings}><ProductionSurface source={source} dependencyStore={null} statusPanel /></SettingsProvider>)
    expect(screen.getByText("Status panel")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Open Silo" })).not.toBeInTheDocument()
  })
})
