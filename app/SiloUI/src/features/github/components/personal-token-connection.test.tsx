import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { PersonalTokenConnection } from "./personal-token-connection"

it("submits a token once and clears it immediately while native validation runs", async () => {
  const user = userEvent.setup()
  let complete!: () => void
  const save = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
  render(<PersonalTokenConnection onSave={save} />)
  await user.click(screen.getByRole("button", { name: "Add token" }))
  const input = screen.getByLabelText("GitHub personal access token")
  expect(input).toHaveAttribute("type", "password")
  await user.type(input, "github_pat_synthetic")
  await user.click(screen.getByRole("button", { name: "Connect token" }))
  expect(save).toHaveBeenCalledExactlyOnceWith("github_pat_synthetic")
  expect(input).toHaveValue("")
  expect(screen.getByRole("button", { name: "Connect token" })).toBeDisabled()
  complete()
  await waitFor(() => expect(screen.queryByLabelText("GitHub personal access token")).not.toBeInTheDocument())
})

it("never renders a credential-bearing native error", async () => {
  const user = userEvent.setup()
  render(<PersonalTokenConnection onSave={vi.fn().mockRejectedValue(new Error("github_pat_private"))} />)
  await user.click(screen.getByRole("button", { name: "Add token" }))
  await user.type(screen.getByLabelText("GitHub personal access token"), "github_pat_private")
  await user.click(screen.getByRole("button", { name: "Connect token" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not connect this token")
  expect(screen.getByRole("alert")).not.toHaveTextContent("github_pat_private")
  expect(screen.getByLabelText("GitHub personal access token")).toHaveValue("")
})

it("offers replacement and removal for a disconnected saved token", async () => {
  const user = userEvent.setup()
  const remove = vi.fn().mockResolvedValue(undefined)
  render(<PersonalTokenConnection status={{ state: "disconnected", saved: true, message: "Expired token" }} onSave={vi.fn()} onRemove={remove} />)
  expect(screen.getByRole("button", { name: "Replace token" })).toBeEnabled()
  await user.click(screen.getByRole("button", { name: "Remove token" }))
  expect(remove).toHaveBeenCalledOnce()
})
