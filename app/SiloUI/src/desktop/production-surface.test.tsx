import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import type { ProductionSource } from "./production-source"
import type { DependencyStore } from "./dependencies"
import { ProductionSurface } from "./production-surface"

const state = vi.hoisted(() => ({ source: {} as object | null, checks: [] as Array<{ id: string; title: string; status: string; detail: string; remediation: string | null }>, retry: vi.fn() }))
vi.mock("./production-source", () => ({ useProductionSource: () => ({ source: state.source, backup: {}, loading: false }) }))
vi.mock("./dependencies", () => ({ useDependencyStore: () => ({ checks: state.checks, retry: state.retry }) }))
vi.mock("./production-onboarding", () => ({ ProductionOnboarding: ({ onOpenApp }: { onOpenApp: () => void }) => <button onClick={onOpenApp}>Open Silo</button> }))
vi.mock("@/features/application/application-app", () => ({ ApplicationApp: ({ source, actions }: { source: { runtimeRepair?: { reason: string; recovery: string; checking: boolean } }; actions: { retryRuntimeChecks: () => void } }) => <div>Main app{source.runtimeRepair && <div role="alert">{source.runtimeRepair.reason}{source.runtimeRepair.recovery}<button disabled={source.runtimeRepair.checking} onClick={actions.retryRuntimeChecks}>Retry checks</button></div>}</div> }))
vi.mock("./status-panel", () => ({ StatusPanel: () => <div>Status panel</div> }))

const source = { applicationActions: {}, statusActions: {}, refresh: vi.fn() } as unknown as ProductionSource
const dependencyStore = {} as DependencyStore

beforeEach(() => { state.source = {}; state.checks = []; vi.clearAllMocks() })

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


describe("production dependency recovery", () => {
  const failure = { id: "runtime-microsandbox", title: "MicroSandbox runtime", status: "unavailable", detail: "Bundled runtime is missing.", remediation: "Reinstall Silo. Keep your VMs and settings." }
  it("shows recovery even when runtime failure prevents reading application state", () => {
    state.source = null
    state.checks = [failure]
    render(<SettingsProvider store={createMemorySettingsStore({ onboardingComplete: true })}><ProductionSurface source={source} dependencyStore={dependencyStore} /></SettingsProvider>)
    expect(screen.getByRole("alert")).toHaveTextContent(failure.remediation)
    fireEvent.click(screen.getByRole("button", { name: "Retry checks" }))
    expect(state.retry).toHaveBeenCalledOnce()
    expect(source.refresh).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: /repair/i })).not.toBeInTheDocument()
  })
  it("retains recovery while rechecking and clears the issue only after passing", () => {
    state.checks = [failure]
    const settings = createMemorySettingsStore({ onboardingComplete: true })
    const view = () => <SettingsProvider store={settings}><ProductionSurface source={source} dependencyStore={dependencyStore} /></SettingsProvider>
    const application = render(view())
    expect(screen.getByRole("alert")).toHaveTextContent(failure.detail)
    fireEvent.click(screen.getByRole("button", { name: "Retry checks" }))
    expect(state.retry).toHaveBeenCalledOnce()
    state.checks = [{ ...failure, status: "pending" }]
    application.rerender(view())
    expect(screen.getByRole("alert")).toHaveTextContent(failure.remediation)
    expect(screen.getByRole("button", { name: "Retry checks" })).toBeDisabled()
    state.checks = [{ ...failure, status: "pass" }]
    application.rerender(view())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    state.checks = [{ ...failure, status: "pending" }]
    application.rerender(view())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
