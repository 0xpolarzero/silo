import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { DependencyDisclosure } from "@/features/onboarding/components/dependency-disclosure"
import { projectOnboarding } from "@/features/onboarding/model/onboarding-state"
import { GitHubStep } from "@/features/onboarding/steps/github-step"
import { onboardingScenarios } from "@/fixtures/scenarios"

describe("onboarding preparation interactions", () => {
  it("projects only the approved dependency inventory with one bundled runtime result", () => {
    const view = projectOnboarding(onboardingScenarios.complete, "connected")

    expect(view.dependencies.map(({ id }) => id)).toEqual(["required-software", "mac-runtime"])
    expect(view.dependencies[0].items.map(({ name }) => name)).toEqual([
      "MicroSandbox runtime", "git", "git-lfs", "tar / gtar", "zstd",
    ])
    expect(view.dependencies[1].items.map(({ name }) => name)).toEqual([
      "macOS 26+", "Apple Silicon", "20 GiB free", "16 GiB memory",
    ])
    expect(view.dependencies[0].items[0].check).toMatchObject({
      id: "runtime-microsandbox",
      status: "pass",
      detail: "Bundled msb 0.6.17 and libkrunfw 5.6.1 passed integrity verification.",
    })
  })

  it("treats an absent required check as unsuccessful", () => {
    const source = {
      ...onboardingScenarios.complete,
      preflightChecks: onboardingScenarios.complete.preflightChecks.filter(({ id }) => id !== "runtime-microsandbox"),
    }
    const view = projectOnboarding(source, "connected")

    expect(view.dependencies[0].status).toBe("failed")
    expect(view.dependencies[0].items[0].check).toMatchObject({ status: "unavailable", detail: "No check result was reported." })
    expect(view.dependencyStatus).toBe("failed")
    expect(view.finishEnabled).toBe(false)
  })

  it("summarizes closed dependency groups and supports keyboard disclosure", async () => {
    const user = userEvent.setup()
    const group = projectOnboarding(onboardingScenarios.running, "connected").dependencies[0]
    render(<DependencyDisclosure group={group} />)

    expect(screen.getByText("5 components ready")).toBeVisible()
    expect(screen.queryByText("MicroSandbox runtime")).not.toBeInTheDocument()
    const trigger = screen.getByRole("button", { name: "Required software" })
    trigger.focus()
    await user.keyboard(" ")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("MicroSandbox runtime")).toBeVisible()
    await user.keyboard(" ")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("MicroSandbox runtime")).not.toBeInTheDocument()
  })

  it("opens a failed bundled runtime check without offering onboarding repair", () => {
    const group = projectOnboarding(onboardingScenarios["dependency-failure"], "connected").dependencies[0]
    render(<DependencyDisclosure group={group} />)

    expect(screen.getByText("1 check needs attention")).toBeVisible()
    const trigger = screen.getByRole("button", { name: "Required software" })
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    const notice = screen.getByRole("alert")
    expect(within(notice).getByText("Bundled MicroSandbox runtime needs attention")).toBeVisible()
    expect(within(notice).getByText("Reinstall this Silo build from a trusted package.")).toBeVisible()
    expect(within(notice).queryByRole("button", { name: /Repair/ })).not.toBeInTheDocument()
  })

  it("requires inline confirmation before clearing onboarding repository access", () => {
    const changeSelections = vi.fn()
    render(<GitHubStep
      workspaces={[{ name: "dev" }]}
      connectionState="connected"
      repositoryOptions={["acme/silo"]}
      workspaceSelections={{ dev: [{ repository: "acme/silo", allowPushes: false }] }}
      workspaceIdentities={{ dev: { name: "Taylor", email: "taylor@example.com", apply: true } }}
      currentHostGitIdentity={{ name: "Taylor", email: "taylor@example.com" }}
      onConnect={vi.fn()}
      onWorkspaceSelectionsChange={changeSelections}
      onWorkspaceIdentityChange={vi.fn()}
      onResetWorkspaceIdentity={vi.fn()}
    />)

    fireEvent.click(screen.getByRole("button", { name: "Clear repositories from dev" }))
    expect(changeSelections).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Confirm clearing repositories from dev" }))
    expect(changeSelections).toHaveBeenCalledExactlyOnceWith("dev", [])
  })
})
