import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource, GitHubWorkspaceOperation } from "../model/application-source"
import { GitHubPage } from "./github-page"

const base = applicationSourceForScenario("complete")
const workspace = base.workspaces.find((w) => !w.computer)!.machine.name

function sourceWith(operations: GitHubWorkspaceOperation[], revision = 1): ApplicationSource {
  return { ...base, github: { ...base.github, state: "connected", account: "taylor", policyRevision: revision, workspaceOperations: operations } }
}

function page(source: ApplicationSource, actions: Partial<ApplicationActions> = {}) {
  return <><Toaster /><GitHubPage source={source} actions={actions as ApplicationActions} /></>
}

afterEach(() => { toast.dismiss() })

describe("GitHub operation notifications", () => {
  it("shows a loading toast while settings apply, not an inline block", async () => {
    const view = render(page(sourceWith([])))
    view.rerender(page(sourceWith([{ workspace, status: "applying", message: "Applying repository access…" }], 2)))
    expect(await screen.findByText("Applying repository access…")).toBeInTheDocument()
    expect(document.querySelector("[role=status][aria-live=polite].border-border")).toBeNull()
  })

  it("keeps a success toast until it is closed", async () => {
    const view = render(page(sourceWith([{ workspace, status: "applying", message: "Applying repository access…" }])))
    view.rerender(page(sourceWith([{ workspace, status: "succeeded", message: "Repository access applied." }], 2)))
    expect(await screen.findByText("GitHub settings applied")).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 4_500))
    expect(screen.getByText("GitHub settings applied")).toBeInTheDocument()
  }, 10_000)

  it("shows a failure toast with Retry and keeps an inline Not applied label", async () => {
    const retry = vi.fn()
    const user = userEvent.setup()
    const view = render(page(sourceWith([{ workspace, status: "applying", message: "Applying repository access…" }]), { retryGitHubConfiguration: retry }))
    view.rerender(page(sourceWith([{ workspace, status: "failed", message: "runtime output", canRetry: true }], 2), { retryGitHubConfiguration: retry }))
    expect(await screen.findByText("GitHub settings couldn’t be applied.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: new RegExp(`not applied for ${workspace}`, "i") })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent("runtime output")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledExactlyOnceWith(workspace)
    await waitFor(() => expect(screen.getAllByText("Retrying GitHub access…").length).toBeGreaterThan(0))
  })

  it("shows only the inline label for a failure already present on load", () => {
    render(page(sourceWith([{ workspace, status: "failed", message: "old failure", canRetry: true }])))
    expect(screen.getByRole("button", { name: new RegExp(`not applied for ${workspace}`, "i") })).toBeInTheDocument()
    expect(screen.queryByText("GitHub settings couldn’t be applied.")).not.toBeInTheDocument()
  })
})
