import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import type { RepositoryPushOperation } from "@/features/application/model/application-source"
import { useRepositoryPushToasts } from "./repository-push-feedback"

const base = { workspace: "dev", repositoryPath: "acme/silo", commitCount: 2 }

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
  it("shows loading, then a success that stays and clears the finished operation", async () => {
    const { update, onDismiss } = setup([])
    update([{ ...base, status: "pushing" }])
    expect(await within(document.body).findByText("Pushing 2 commits · silo")).toBeInTheDocument()
    update([{ ...base, status: "succeeded" }])
    expect(await within(document.body).findByText("Pushed 2 commits · silo")).toBeInTheDocument()
    expect(within(document.body).queryByText("Pushing 2 commits · silo")).not.toBeInTheDocument()
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo")
  })

  it("shows a failure with Retry that pushes the same commits again", async () => {
    const { update, onPush } = setup([{ ...base, status: "pushing" }])
    update([{ ...base, status: "failed", message: "The remote branch changed." }])
    expect(await within(document.body).findByText("Push failed · silo")).toBeInTheDocument()
    expect(within(document.body).getByText("The remote branch changed.")).toBeInTheDocument()
    await userEvent.setup().click(within(document.body).getByRole("button", { name: "Retry" }))
    expect(onPush).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo", 2)
  })

  it("does not announce operations that were already finished at load", () => {
    const { onDismiss } = setup([{ ...base, status: "succeeded" }, { ...base, repositoryPath: "acme/other", status: "failed", message: "Old failure" }])
    expect(screen.queryByText(/Pushed|Push failed|Old failure/)).not.toBeInTheDocument()
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("dev", "acme/silo")
  })
})
