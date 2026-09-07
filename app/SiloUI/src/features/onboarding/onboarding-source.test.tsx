import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OnboardingApp } from "./onboarding-app"
import { onboardingScenarios } from "@/fixtures/scenarios"

afterEach(() => vi.useRealTimers())

describe("onboarding source boundary", () => {
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
    const view = render(<OnboardingApp {...props} completed={false} />)
    await user.click(screen.getByRole("tab", { name: /Review/ }))
    fireEvent.click(screen.getByRole("button", { name: "Finish" }))
    expect(actions.finishSetup).toHaveBeenCalledOnce()
    expect(screen.queryByText("Setup complete")).not.toBeInTheDocument()
    view.rerender(<OnboardingApp {...props} completed />)
    expect(screen.getByRole("status")).toHaveTextContent("Setup complete")
  })
})
