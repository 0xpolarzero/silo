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

async function startUserChange(user: ReturnType<typeof userEvent.setup>, actions: Partial<ApplicationActions> = {}) {
  await user.click(screen.getByRole("button", { name: "Disable access" }))
  expect(actions.setGitHubAccessEnabled).toHaveBeenCalled()
}

describe("GitHub operation notifications", () => {
  it("shows a loading toast while a user change applies, not an inline block", async () => {
    const user = userEvent.setup()
    const actions = { setGitHubAccessEnabled: vi.fn() }
    const view = render(page(sourceWith([]), actions))
    await startUserChange(user, actions)
    view.rerender(page(sourceWith([{ workspace, status: "applying", message: "Applying repository access…" }], 2), actions))
    expect(await screen.findByText("Applying repository access…")).toBeInTheDocument()
    expect(document.querySelector("[role=status][aria-live=polite].border-border")).toBeNull()
  })

  it("keeps a success toast for a user change until it is closed", async () => {
    const user = userEvent.setup()
    const actions = { setGitHubAccessEnabled: vi.fn() }
    const view = render(page(sourceWith([]), actions))
    await startUserChange(user, actions)
    view.rerender(page(sourceWith([{ workspace, status: "applying", message: "Applying repository access…" }], 2), actions))
    view.rerender(page(sourceWith([{ workspace, status: "succeeded", message: "Repository access applied." }], 3), actions))
    expect(await screen.findByText("GitHub settings applied")).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 4_500))
    expect(screen.getByText("GitHub settings applied")).toBeInTheDocument()
  }, 10_000)

  it("never notifies for background applying then succeeded", async () => {
    const view = render(page(sourceWith([])))
    view.rerender(page(sourceWith([{ workspace, status: "applying", message: "Applying GitHub settings." }], 2)))
    view.rerender(page(sourceWith([{ workspace, status: "succeeded", message: "GitHub access verified." }], 3)))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.queryByText("GitHub settings applied")).not.toBeInTheDocument()
    expect(screen.queryByText("Applying GitHub settings.")).not.toBeInTheDocument()
  })

  it("shows a failure toast with Retry for a user change and keeps an inline Not applied label", async () => {
    const retry = vi.fn()
    const user = userEvent.setup()
    const actions = { retryGitHubConfiguration: retry, setGitHubAccessEnabled: vi.fn() }
    const view = render(page(sourceWith([]), actions))
    await startUserChange(user, actions)
    view.rerender(page(sourceWith([{ workspace, status: "applying", message: "Applying repository access…" }]), actions))
    view.rerender(page(sourceWith([{ workspace, status: "failed", message: "runtime output", canRetry: true }], 2), actions))
    expect(await screen.findByText("GitHub settings could not be applied.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: new RegExp(`not applied for ${workspace}`, "i") })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent("runtime output")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledExactlyOnceWith(workspace)
    await waitFor(() => expect(screen.getAllByText("Retrying GitHub access…").length).toBeGreaterThan(0))
  })

  it("shows only the inline label for a background failure", async () => {
    const view = render(page(sourceWith([{ workspace, status: "succeeded", message: "GitHub access verified." }])))
    view.rerender(page(sourceWith([{ workspace, status: "failed", message: "background failure", canRetry: true }], 2)))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.getByRole("button", { name: new RegExp(`not applied for ${workspace}`, "i") })).toBeInTheDocument()
    expect(screen.queryByText("GitHub settings could not be applied.")).not.toBeInTheDocument()
  })

  it("shows only the inline label for a failure already present on load", () => {
    render(page(sourceWith([{ workspace, status: "failed", message: "old failure", canRetry: true }])))
    expect(screen.getByRole("button", { name: new RegExp(`not applied for ${workspace}`, "i") })).toBeInTheDocument()
    expect(screen.queryByText("GitHub settings could not be applied.")).not.toBeInTheDocument()
  })
})

describe("GitHub repository clear confirmation", () => {
  it("closes on one Escape after hovering the clear button", async () => {
    const user = userEvent.setup()
    const actions = {}
    render(page(sourceWith([]), actions))
    const trigger = screen.getAllByRole("button", { name: /^Clear repositories from / })[0]
    await user.hover(trigger)
    await user.click(trigger)
    expect(await screen.findByText(/^Remove all repositories from /)).toBeVisible()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText(/^Remove all repositories from /)).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})
