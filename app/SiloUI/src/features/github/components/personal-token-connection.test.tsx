import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { PersonalTokenConnection } from "./personal-token-connection"
import * as operationToast from "@/lib/operation-toast"

afterEach(() => { toast.dismiss() })

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
  render(<><Toaster /><PersonalTokenConnection onSave={vi.fn().mockRejectedValue(new Error("github_pat_private"))} /></>)
  await user.click(screen.getByRole("button", { name: "Add token" }))
  await user.type(screen.getByLabelText("GitHub personal access token"), "github_pat_private")
  await user.click(screen.getByRole("button", { name: "Connect token" }))
  expect(await screen.findByText("Could not connect token")).toBeInTheDocument()
  expect(screen.getByText(/Check its validity/)).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent("github_pat_private")
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

it("invalidates a failed removal retry before replacing the token", async () => {
  const user = userEvent.setup()
  const failure = vi.spyOn(operationToast, "showActionFailure")
  const remove = vi.fn().mockRejectedValueOnce(new Error("Credential store unavailable")).mockResolvedValue(undefined)
  let complete!: () => void
  const save = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
  render(<><Toaster /><PersonalTokenConnection status={{ state: "connected", saved: true, account: "original" }} onSave={save} onRemove={remove} /></>)
  await user.click(screen.getByRole("button", { name: "Remove token" }))
  expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible()
  const retry = failure.mock.calls[0][2]!
  await user.click(screen.getByRole("button", { name: "Replace token" }))
  await user.type(screen.getByLabelText("GitHub personal access token"), "github_pat_replacement")
  await user.click(screen.getByRole("button", { name: "Connect token" }))
  act(() => retry())
  expect(remove).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument())
  await act(async () => complete())
  act(() => retry())
  expect(remove).toHaveBeenCalledOnce()
})

it("allows one removal retry while preventing duplicate in-flight removals", async () => {
  const user = userEvent.setup()
  const failure = vi.spyOn(operationToast, "showActionFailure")
  let complete!: () => void
  const remove = vi.fn().mockRejectedValueOnce(new Error("Credential store unavailable"))
    .mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  render(<PersonalTokenConnection status={{ state: "connected", saved: true, account: "original" }} onRemove={remove} />)
  await user.click(screen.getByRole("button", { name: "Remove token" }))
  const retry = failure.mock.calls[0][2]!
  act(() => { retry(); retry() })
  expect(remove).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("button", { name: "Remove token" })).toBeDisabled()
  await act(async () => complete())
  act(() => retry())
  expect(remove).toHaveBeenCalledTimes(2)
})

it("invalidates removal retries when the component unmounts", async () => {
  const user = userEvent.setup()
  const failure = vi.spyOn(operationToast, "showActionFailure")
  const remove = vi.fn().mockRejectedValueOnce(new Error("Credential store unavailable")).mockResolvedValue(undefined)
  render(<Toaster />)
  const view = render(<PersonalTokenConnection status={{ state: "connected", saved: true, account: "original" }} onRemove={remove} />)
  await user.click(screen.getByRole("button", { name: "Remove token" }))
  expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible()
  const retry = failure.mock.calls[0][2]!
  view.unmount()
  act(() => retry())
  expect(remove).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument())
})
