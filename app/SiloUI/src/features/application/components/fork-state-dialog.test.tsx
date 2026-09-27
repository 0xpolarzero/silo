import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { ForkStateDialog } from "./fork-state-dialog"

it("shows immediate indeterminate progress and the reported stage while a fork is pending", () => {
  let finishFork!: () => void
  const fork = vi.fn(() => new Promise<void>(resolve => { finishFork = resolve }))
  const onClose = vi.fn()
  render(<ForkStateDialog sandboxName="dev" disabled={false} progressStage="copying-disk" fork={fork} onClose={onClose} />)

  fireEvent.change(screen.getByRole("textbox", { name: "New sandbox name" }), { target: { value: "experiment" } })
  fireEvent.click(screen.getByRole("button", { name: "Fork" }))

  expect(fork).toHaveBeenCalledWith("experiment")
  expect(screen.getByRole("status")).toHaveTextContent("copying-disk")
  expect(screen.getByRole("progressbar", { name: "Fork progress" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
  expect(onClose).not.toHaveBeenCalled()

  finishFork()
})

it("keeps the dialog open and shows an error when creating the fork fails", async () => {
  const fork = vi.fn().mockRejectedValue(new Error("The source is busy."))
  const onClose = vi.fn()
  render(<ForkStateDialog sandboxName="dev" disabled={false} fork={fork} onClose={onClose} />)

  fireEvent.change(screen.getByRole("textbox", { name: "New sandbox name" }), { target: { value: "experiment" } })
  fireEvent.click(screen.getByRole("button", { name: "Fork" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("The source is busy.")
  expect(screen.getByRole("textbox", { name: "New sandbox name" })).toBeEnabled()
  expect(onClose).not.toHaveBeenCalled()
})
