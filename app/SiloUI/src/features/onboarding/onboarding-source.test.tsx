import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OnboardingApp } from "./onboarding-app"
import { onboardingScenarios } from "@/fixtures/scenarios"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "@/fixtures/system-integrations"

afterEach(() => vi.useRealTimers())

describe("onboarding source boundary", () => {
  it("loads real machines arriving after dependencies without resetting the current step", async () => {
    const settings = createMemorySettingsStore()
    const actions = { connectGitHub: vi.fn(), saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn() }
    const wrap = (source: typeof onboardingScenarios.complete) => <SettingsProvider store={settings}><OnboardingApp source={source} actions={actions} githubConnectionState="disconnected" completed={false} /></SettingsProvider>
    const view = render(wrap({ ...onboardingScenarios.complete, machineConfigurations: [] }))
    await userEvent.setup().click(screen.getByRole("tab", { name: /GitHub/ }))
    view.rerender(wrap(onboardingScenarios.complete))
    expect(settings.getSnapshot().onboardingDraft?.machines).toEqual(onboardingScenarios.complete.machineConfigurations)
    expect(screen.getByRole("tab", { name: /GitHub/ })).toHaveAttribute("aria-selected", "true")
  })

  it("waits for the source to confirm GitHub connection", async () => {
    const user = userEvent.setup()
    const actions = {
      connectGitHub: vi.fn(),
      saveMachineConfiguration: vi.fn(),
      retryWorkspaceSetup: vi.fn(),
      finishSetup: vi.fn(),
    }
    const props = { source: onboardingScenarios.complete, actions, completed: false }
    const view = render(<OnboardingApp {...props} githubConnectionState="disconnected" />)
    await user.click(screen.getByRole("tab", { name: /GitHub/ }))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))
    expect(actions.connectGitHub).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole("heading", { name: "Not connected" })).toBeVisible()

    view.rerender(<OnboardingApp {...props} githubConnectionState="connecting" />)
    expect(screen.getByRole("heading", { name: "Connecting to GitHub…" })).toBeVisible()
    view.rerender(<OnboardingApp {...props} githubConnectionState="connected" />)
    expect(screen.getByRole("heading", { name: "Connected to GitHub" })).toBeVisible()
  })

  it("waits for confirmed completion before showing the handoff", async () => {
    const user = userEvent.setup()
    const actions = {
      connectGitHub: vi.fn(),
      saveMachineConfiguration: vi.fn(),
      retryWorkspaceSetup: vi.fn(),
      finishSetup: vi.fn(),
    }
    const props = { source: onboardingScenarios.complete, actions, githubConnectionState: "connected" as const }
    const settings = createMemorySettingsStore()
    const integrations = createFixtureSystemIntegrationStore(settings)
    const wrap = (completed: boolean) => <SettingsProvider store={settings}><SystemIntegrationProvider store={integrations}><OnboardingApp {...props} completed={completed} /></SystemIntegrationProvider></SettingsProvider>
    const view = render(wrap(false))
    await user.click(screen.getByRole("tab", { name: /Review/ }))
    fireEvent.click(screen.getByRole("button", { name: "Finish" }))
    expect(actions.finishSetup).toHaveBeenCalledOnce()
    expect(screen.queryByText("Setup complete")).not.toBeInTheDocument()
    view.rerender(wrap(true))
    expect(screen.getByRole("status")).toHaveTextContent("Setup complete")
  })
})
