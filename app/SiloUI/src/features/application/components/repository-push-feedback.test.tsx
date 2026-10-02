import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import type { RepositoryPushOperation } from "@/features/application/model/application-source"
import { RepositoryPushButton, RepositoryPushFeedback } from "./repository-push-feedback"
import { useRepositoryPushToasts } from "./use-repository-push-toasts"

const target = { repository: "acme/silo", branch: "main", commit: "0123456789abcdef0123456789abcdef01234567" }
const base = { workspace: "dev", repositoryPath: "acme/silo", commitCount: 2, target }
const row = { path: "acme/silo", branch: "feature", ahead: 3, behind: 0, dirty: false, repository: "acme/silo", head: "fedcba9876543210fedcba9876543210fedcba98" }

function Harness({ operations, onPush, onDismiss }: { operations: RepositoryPushOperation[]; onPush: () => void; onDismiss: () => void }) {
  useRepositoryPushToasts(operations, { onPush, onDismiss })
  return <Toaster />
}

function setup(operations: RepositoryPushOperation[]) {
  const onPush = vi.fn()
  const onDismiss = vi.fn()
  const view = render(<Harness operations={operations} onPush={onPush} onDismiss={onDismiss} />)
  const update = (next: RepositoryPushOperation[]) => view.rerender(<Harness operations={next} onPush={onPush} onDismiss={onDismiss} />)
  return { onPush, onDismiss, update }
}

describe("repository push notifications", () => {
  it("updates the message and commit count while a push remains in progress", async () => {
    const { update } = setup([{ ...base, status: "pushing" }])
    expect(await screen.findByText("Pushing 2 commits")).toBeInTheDocument()
    update([{ ...base, status: "pushing", commitCount: 3, message: "Waiting for push status" }])
    expect(await screen.findByText("silo · Waiting for push status")).toBeInTheDocument()
    expect(screen.getByText("Pushing 3 commits")).toBeInTheDocument()
    expect(screen.queryByText("Pushing 2 commits")).not.toBeInTheDocument()
  })

  it("replaces failed push details and retries the latest confirmed target", async () => {
    const { update, onPush } = setup([{ ...base, status: "pushing" }])
    update([{ ...base, status: "failed", message: "SSH disconnected" }])
    expect(await screen.findByText("SSH disconnected")).toBeInTheDocument()
    const latest = { ...target, branch: "release", commit: "a".repeat(40) }
    update([{ ...base, status: "failed", message: "Remote branch changed", commitCount: 3, target: latest }])
    expect(await screen.findByText("Remote branch changed")).toBeInTheDocument()
    expect(screen.queryByText("SSH disconnected")).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    expect(onPush).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo", 3, latest)
  })

  it("updates Retry when only the confirmed target changes", async () => {
    const { update, onPush } = setup([{ ...base, status: "pushing" }])
    const failed = { ...base, status: "failed" as const, message: "Push rejected" }
    update([failed])
    expect(await screen.findByText("Push rejected")).toBeInTheDocument()
    const latest = { ...target, commit: "b".repeat(40) }
    update([{ ...failed, target: latest }])
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    expect(onPush).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo", 2, latest)
  })

  it("shows loading, then a success that stays and clears the finished operation", async () => {
    const { update, onDismiss } = setup([])
    update([{ ...base, status: "pushing" }])
    expect(await within(document.body).findByText("Pushing 2 commits")).toBeInTheDocument()
    update([{ ...base, status: "succeeded" }])
    expect(await within(document.body).findByText("Pushed 2 commits · silo")).toBeInTheDocument()
    expect(within(document.body).queryByText("Pushing 2 commits")).not.toBeInTheDocument()
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo")
  })

  it("shows a failure with Retry that pushes the same confirmed target again", async () => {
    const { update, onPush } = setup([{ ...base, status: "pushing" }])
    update([{ ...base, status: "failed", message: "The remote branch changed." }])
    expect(await within(document.body).findByText("Push failed · silo")).toBeInTheDocument()
    expect(within(document.body).getByText("The remote branch changed.")).toBeInTheDocument()
    await userEvent.setup().click(within(document.body).getByRole("button", { name: "Retry" }))
    expect(onPush).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo", 2, target)
  })

  it("offers no notification Retry for a push without a confirmed target", async () => {
    const { update } = setup([{ ...base, target: undefined, status: "pushing" }])
    update([{ ...base, target: undefined, status: "failed", message: "Update Silo." }])
    expect(await within(document.body).findByText("Push failed · silo")).toBeInTheDocument()
    expect(within(document.body).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })

  it("offers Cancel once the host accepts cancelling the running push", async () => {
    const onCancel = vi.fn()
    const pushing = [{ ...base, status: "pushing" as const }]
    const entry = { id: 7, label: "Pushing from dev", kind: "push" as const, vmId: "vm", vmName: "dev", sinceMs: 0, cancellable: true, expectedMs: null, blockedByHidden: false }
    function CancelHarness({ cancellable }: { cancellable: boolean }) {
      useRepositoryPushToasts(pushing, { onPush: vi.fn(), onDismiss: vi.fn(), queue: { running: [{ ...entry, cancellable }], waiting: [] }, onCancel })
      return <Toaster />
    }
    const view = render(<CancelHarness cancellable={false} />)
    expect(await within(document.body).findByText("Pushing 2 commits")).toBeInTheDocument()
    expect(within(document.body).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    view.rerender(<CancelHarness cancellable />)
    const user = userEvent.setup()
    await user.click(await within(document.body).findByRole("button", { name: "Cancel" }))
    expect(onCancel).not.toHaveBeenCalled()
    await user.click(within(document.body).getByRole("button", { name: "Stop push" }))
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(7)
  })

  it("does not announce operations that were already finished at load", () => {
    const { onDismiss } = setup([{ ...base, status: "succeeded" }, { ...base, repositoryPath: "acme/other", status: "failed", message: "Old failure" }])
    expect(screen.queryByText(/Pushed|Push failed|Old failure/)).not.toBeInTheDocument()
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo")
  })
})

describe("push confirmation", () => {
  it("names the repository, branch and commit and pushes exactly that target", async () => {
    const user = userEvent.setup()
    const onPush = vi.fn()
    render(<RepositoryPushButton repository={row} label="Push 3 commits" onPush={onPush}>Push 3 commits</RepositoryPushButton>)
    await user.click(screen.getByRole("button", { name: "Push 3 commits" }))
    expect(onPush).not.toHaveBeenCalled()
    expect(screen.getByText("Push to acme/silo?")).toBeVisible()
    expect(screen.getByText("Branch feature · 3 commits · fedcba9")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onPush).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Push 3 commits" }))
    await user.click(screen.getByRole("button", { name: "Push" }))
    expect(onPush).toHaveBeenCalledExactlyOnceWith({ repository: "acme/silo", branch: "feature", commit: row.head })
  })

  it("cannot push a repository without a GitHub destination or head commit", () => {
    render(<>
      <RepositoryPushButton repository={{ ...row, repository: null }} label="No origin" onPush={vi.fn()}>Push</RepositoryPushButton>
      <RepositoryPushButton repository={{ ...row, head: undefined }} label="No head" onPush={vi.fn()}>Push</RepositoryPushButton>
    </>)
    expect(screen.getByRole("button", { name: "No origin" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "No head" })).toBeDisabled()
  })

  it("retries a failed push only after confirming the repository's current target", async () => {
    const user = userEvent.setup()
    const onPush = vi.fn()
    render(<RepositoryPushFeedback operation={{ ...base, status: "failed", message: "The repository changed after you confirmed the push." }} workspace="dev" repositoryPath="acme/silo" repository={row} onPush={onPush} onDismiss={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Push failed for acme/silo. Show details" }))
    await user.click(screen.getByRole("button", { name: "Retry push for acme/silo" }))
    expect(screen.getByText("Branch feature · 3 commits · fedcba9")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Push" }))
    expect(onPush).toHaveBeenCalledExactlyOnceWith({ repository: "acme/silo", branch: "feature", commit: row.head })
  })
})
