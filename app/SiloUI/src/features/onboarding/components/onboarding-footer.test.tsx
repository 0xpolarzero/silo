import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { onboardingScenarios } from "@/fixtures/scenarios"
import { projectOnboarding } from "@/features/onboarding/model/onboarding-state"
import type { OnboardingSource } from "@/features/onboarding/model/onboarding-source"
import { OnboardingFooter } from "./onboarding-footer"

const setupQueue: NonNullable<OnboardingSource["setupQueue"]> = ["workspaceRun", "workspaceVerify", "identityRun", "identityVerify", "completion"].map((id) => ({ id: id as NonNullable<OnboardingSource["setupQueue"]>[number]["id"], status: "idle" }))

describe("onboarding queue feedback", () => {
  it("distinguishes idle setup from submitted work", () => {
    const viewModel = projectOnboarding({ ...onboardingScenarios.complete, setupQueue }, "disconnected")
    const view = render(<OnboardingFooter activeStep="workspaces" viewModel={viewModel} onBack={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByText("Not started · Continue to start this step")).toBeVisible()
    expect(screen.queryByText("Waiting · Setup tasks are queued")).not.toBeInTheDocument()
    view.rerender(<OnboardingFooter activeStep="dependencies" viewModel={viewModel} onBack={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByText("Ready · Continue to configure sandboxes")).toBeVisible()
    view.rerender(<OnboardingFooter activeStep="review" viewModel={{ ...viewModel, finishEnabled: true }} onBack={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByText("Ready · Finish setup")).toBeVisible()
    const running = projectOnboarding({ ...onboardingScenarios.complete, setupQueue: setupQueue.map((item) => item.id === "workspaceRun" ? { ...item, status: "running" } : item) }, "disconnected")
    view.rerender(<OnboardingFooter activeStep="github" viewModel={running} onBack={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByText("In progress · Create sandboxes")).toBeVisible()
  })

  it("projects only explicit operations and does not invent GitHub completion", () => {
    const view = projectOnboarding({ ...onboardingScenarios.complete, setupQueue }, "disconnected")
    expect(view.queueItems.map(({ id }) => id)).toEqual(setupQueue.map(({ id }) => id))
    expect(view.queueItems.every(({ status }) => status === "idle")).toBe(true)
    expect(view.workspaceProgress.currentMessage).toBe("Continue to create sandboxes")
    expect(view.workspaceProgress.workspaces.every(({ status }) => status !== "ready")).toBe(true)
    expect(view.workspaceProgress.totalOperations).toBe(onboardingScenarios.complete.machineConfigurations.length * 2)
  })
})
