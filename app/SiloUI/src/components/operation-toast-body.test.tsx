import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { OperationToastBody } from "./operation-toast-body"

describe("OperationToastBody step accessibility", () => {
  it("exposes the status of every step and identifies the current step", () => {
    render(<OperationToastBody title="Importing sandbox" steps={[
      { label: "Verify archive", state: "done" },
      { label: "Copy disks", state: "current" },
      { label: "Start sandbox", state: "pending" },
      { label: "Clean up", state: "failed" },
    ]} />)
    const steps = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem")
    expect(steps[0]).toHaveTextContent("Verify archive: Completed")
    expect(steps[1]).toHaveTextContent("Copy disks: In progress")
    expect(steps[2]).toHaveTextContent("Start sandbox: Pending")
    expect(steps[3]).toHaveTextContent("Clean up: Failed")
    expect(steps[1]).toHaveAttribute("aria-current", "step")
    for (const step of [steps[0], steps[2], steps[3]]) expect(step).not.toHaveAttribute("aria-current")
  })
})

describe("OperationToastBody cancel confirmation", () => {
  it("returns focus to Cancel when keeping the operation running", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<OperationToastBody title="Importing sandbox" cancel={{
      confirm: { prompt: "Stop importing?", confirmLabel: "Stop" }, onCancel,
    }} />)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByRole("button", { name: "Keep going" })).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(screen.queryByRole("group", { name: "Confirm cancel" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    expect(onCancel).not.toHaveBeenCalled()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("button", { name: "Keep going" })).toHaveFocus()
  })
})
