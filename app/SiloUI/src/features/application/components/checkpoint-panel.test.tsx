import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import type { ApplicationActions, ApplicationWorkspace } from "@/features/application/model/application-source"
import { CheckpointPanel } from "./checkpoint-panel"

const workspace = {
  machine: { id: "vm-dev", name: "dev", kind: "vm" },
  checkpoints: [{ id: "point-1", name: "Before refactor", createdAt: "2026-09-25T10:00:00Z", scope: "full", reason: "manual" }],
} as ApplicationWorkspace

it("requires a deliberate confirmation for restore and identifies the recovery checkpoint", () => {
  const restoreCheckpoint = vi.fn().mockResolvedValue(undefined)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ restoreCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  expect(screen.getByText(/first saves a recovery checkpoint/)).toBeVisible()
  expect(restoreCheckpoint).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(restoreCheckpoint).not.toHaveBeenCalled()
})

it("creates a stopped fork from the selected immutable checkpoint", () => {
  const forkCheckpoint = vi.fn().mockResolvedValue(undefined)
  render(<CheckpointPanel workspace={workspace} target="dev" actions={{ forkCheckpoint } as unknown as ApplicationActions} disabled={false} />)
  fireEvent.click(screen.getByRole("button", { name: "Fork" }))
  expect(screen.getByText(/creating it runs no guest programs/)).toBeVisible()
  fireEvent.change(screen.getByRole("textbox", { name: "Fork name" }), { target: { value: "experiment" } })
  fireEvent.click(screen.getByRole("button", { name: "Create stopped fork" }))
  expect(forkCheckpoint).toHaveBeenCalledWith("dev", "point-1", "experiment")
})
