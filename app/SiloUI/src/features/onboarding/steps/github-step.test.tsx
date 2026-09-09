import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { GitHubStep } from "./github-step"
import type { GitHubAccessEditorProps } from "@/features/github/components/github-access-editor"

const props: GitHubAccessEditorProps = { workspaces: [], connectionState: "connected", repositoryOptions: [], workspaceSelections: {}, workspaceIdentities: {}, currentHostGitIdentity: null, onConnect: vi.fn(), onWorkspaceSelectionsChange: vi.fn(), onWorkspaceIdentityChange: vi.fn(), onResetWorkspaceIdentity: vi.fn() }

describe("GitHub setup feedback", () => {
  it("shows verified progress and only safe GitHub activity beneath the connection header", async () => {
    const user = userEvent.setup()
    render(<GitHubStep {...props} queueItems={[
      { id: "identityRun", label: "Save Git identities", status: "succeeded" },
      { id: "identityVerify", label: "Verify Git identities", status: "succeeded" },
      { id: "githubRun", label: "Save GitHub", status: "succeeded" },
      { id: "githubVerify", label: "Verify GitHub", status: "running" },
    ]} activityEvents={[
      { schemaVersion: 1, type: "progress", requestId: "github", phase: "github", step: "verify", message: "Waiting for sandbox confirmation.", safeForDisplay: true },
      { schemaVersion: 1, type: "progress", requestId: "github", phase: "github", step: "verify", message: "private token", safeForDisplay: false },
      { schemaVersion: 1, type: "progress", requestId: "vm", phase: "workspaces", step: "create", message: "Unrelated VM activity", safeForDisplay: true },
    ]} />)
    expect(screen.getByRole("heading", { name: "Connected to GitHub" })).toBeVisible()
    expect(screen.getByRole("progressbar", { name: "GitHub setup progress" })).toHaveAttribute("aria-valuenow", "75")
    expect(screen.getByText("3 of 4 operations complete")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Expand activity" }))
    expect(screen.getByLabelText("Sandbox activity")).toHaveTextContent("Waiting for sandbox confirmation.")
    expect(screen.queryByText(/private token|Unrelated VM activity/)).not.toBeInTheDocument()
  })

  it("does not reveal half-complete progress from background identity verification", () => {
    render(<GitHubStep {...props} queueItems={[
      { id: "identityRun", label: "Save Git identities", status: "succeeded" },
      { id: "identityVerify", label: "Verify Git identities", status: "succeeded" },
      { id: "githubRun", label: "Save GitHub", status: "idle" },
      { id: "githubVerify", label: "Verify GitHub", status: "idle" },
    ]} />)
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Expand activity" })).not.toBeInTheDocument()
  })

  it("keeps progress and activity hidden before Continue, including browser authorization", () => {
    render(<GitHubStep {...props} connectionState="connecting" />)
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Expand activity" })).not.toBeInTheDocument()
  })
})
