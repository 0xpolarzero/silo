import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { UpdatesCard, UpdateNotice } from "./updates"
import { UpdatesProvider, type UpdateBackend, type UpdateSnapshot } from "./update-store"

const state: UpdateSnapshot = { phase: "idle", lastChecked: null, retryAction: null, currentVersion: "0.1.0", availableVersion: null, releaseNotes: null, downloadedBytes: 0, totalBytes: null, automaticChecks: true, packageKind: "macos", releaseUrl: "https://github.com/0xpolarzero/silo/releases", error: null, errorDetails: null, installBlockReason: null, runningSandboxes: [], canInstall: true }
function mount(initial: Partial<UpdateSnapshot> = {}) {
  let emit!: (value: UpdateSnapshot) => void
  const backend: UpdateBackend = {
    read: vi.fn(async () => ({ ...state, ...initial })),
    subscribe: vi.fn(async (receive) => { emit = receive; return vi.fn() }),
    check: vi.fn(async () => ({ ...state, phase: "available" as const, availableVersion: "0.2.0" })),
    download: vi.fn(async () => ({ ...state, phase: "ready" as const, availableVersion: "0.2.0" })),
    install: vi.fn(async () => ({ ...state, phase: "installing" as const })),
    setAutomaticChecks: vi.fn(async (enabled) => ({ ...state, automaticChecks: enabled })),
    openRelease: vi.fn(async () => {}),
  }
  const open = vi.fn()
  render(<UpdatesProvider backend={backend}><UpdateNotice onOpen={open} /><UpdatesCard /></UpdatesProvider>)
  return { backend, open, emit: (patch: Partial<UpdateSnapshot>) => act(() => emit({ ...state, ...initial, ...patch })) }
}
it("loads the installed version without a fake up-to-date result and persists automatic checks", async () => {
  const user = userEvent.setup()
  const { backend } = mount()
  expect(await screen.findByText("Version 0.1.0")).toBeVisible()
  expect(screen.queryByText("Silo is up to date")).not.toBeInTheDocument()
  expect(screen.getByRole("switch", { name: "Automatically check for updates" })).toBeChecked()
  await user.click(screen.getByRole("switch", { name: "Automatically check for updates" }))
  expect(backend.setAutomaticChecks).toHaveBeenCalledWith(false)
  expect(screen.getByRole("switch", { name: "Automatically check for updates" })).not.toBeChecked()
})
it("checks and downloads only on request, displays real progress, and requires confirmation before stopping sandboxes", async () => {
  const user = userEvent.setup()
  const { backend, emit } = mount()
  await user.click(await screen.findByRole("button", { name: "Check for updates" }))
  expect(backend.download).not.toHaveBeenCalled()
  expect(await screen.findByRole("button", { name: "Download update" })).toBeEnabled()
  emit({ phase: "downloading", availableVersion: "0.2.0", downloadedBytes: 25, totalBytes: 100 })
  expect(screen.getByRole("progressbar", { name: "Update download" })).toHaveAttribute("aria-valuenow", "25")
  emit({ phase: "downloading", downloadedBytes: 25, totalBytes: null })
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow")
  emit({ phase: "ready" as const, availableVersion: "0.2.0", runningSandboxes: ["dev"] })
  await user.click(screen.getByRole("button", { name: "Restart and update" }))
  expect(backend.install).not.toHaveBeenCalled()
  expect(screen.getByText(/dev will stop/)).toBeVisible()
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("button", { name: "Stop sandboxes and update" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Restart and update" }))
  await user.click(screen.getByRole("button", { name: "Stop sandboxes and update" }))
  expect(backend.install).toHaveBeenCalledWith(true)
})
it("does not permit installation during active operations", async () => {
  mount({ phase: "ready" as const, availableVersion: "0.2.0", canInstall: false, installBlockReason: "Wait for active operations to finish." })
  expect(await screen.findByRole("button", { name: "Restart and update" })).toBeDisabled()
  expect(screen.getByText("Wait for active operations to finish.")).toBeVisible()
})
it("opens the package release for manual installations instead of offering native installation", async () => {
  const user = userEvent.setup()
  const { backend } = mount({ packageKind: "manual", phase: "available" as const, availableVersion: "0.2.0" })
  await user.click(await screen.findByRole("button", { name: "Download package" }))
  expect(backend.openRelease).toHaveBeenCalledOnce()
  expect(backend.download).not.toHaveBeenCalled()
  expect(screen.queryByRole("button", { name: "Restart and update" })).not.toBeInTheDocument()
})
it("keeps native failure details collapsed and shows a useful retry", async () => {
  const user = userEvent.setup()
  const { backend } = mount({ phase: "error", error: "The download was interrupted.", errorDetails: "Network connection closed.", availableVersion: "0.2.0" })
  expect(await screen.findByRole("alert")).toHaveTextContent("The download was interrupted.")
  expect(screen.getByText("Details").closest("details")).not.toHaveAttribute("open")
  await user.click(screen.getByRole("button", { name: "Retry" }))
  expect(backend.check).toHaveBeenCalledOnce()
})
it("does not replace newer native download progress with a stale command result", async () => {
  const user = userEvent.setup()
  const { backend, emit } = mount()
  let resolve!: (value: UpdateSnapshot) => void
  vi.mocked(backend.check).mockImplementation(() => new Promise((done) => { resolve = done }))
  await user.click(await screen.findByRole("button", { name: "Check for updates" }))
  emit({ phase: "downloading", downloadedBytes: 40, totalBytes: 100 })
  await act(async () => resolve({ ...state, phase: "checking" }))
  await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40"))
})
it("shows up to date only after the native checker confirms it", async () => {
  mount({ lastChecked: "2026-09-10T12:00:00Z" })
  expect(await screen.findByText("Version 0.1.0 · Silo is up to date")).toBeVisible()
})
it("retries a failed download directly without discarding the selected update", async () => {
  const user = userEvent.setup()
  const { backend } = mount({ phase: "error", error: "Download interrupted.", retryAction: "download", availableVersion: "0.2.0" })
  await user.click(await screen.findByRole("button", { name: "Retry" }))
  expect(backend.download).toHaveBeenCalledOnce()
  expect(backend.check).not.toHaveBeenCalled()
})
it("requires a fresh stop confirmation when retrying installation and dismisses it outside", async () => {
  const user = userEvent.setup()
  const { backend } = mount({ phase: "error", error: "Could not stop dev.", retryAction: "install", availableVersion: "0.2.0", runningSandboxes: ["dev"] })
  await user.click(await screen.findByRole("button", { name: "Retry" }))
  expect(backend.install).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible()
  await user.click(screen.getByRole("heading", { name: "Updates" }))
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Retry" }))
  await user.click(screen.getByRole("button", { name: "Stop sandboxes and update" }))
  expect(backend.install).toHaveBeenCalledWith(true)
})
it("keeps the same update notice dismissed while native state refreshes", async () => {
  const user = userEvent.setup()
  const { emit } = mount({ phase: "available", availableVersion: "0.2.0" })
  await user.click(await screen.findByRole("button", { name: "Dismiss update notice" }))
  emit({ phase: "available", availableVersion: "0.2.0" })
  expect(screen.queryByRole("button", { name: "View update" })).not.toBeInTheDocument()
  emit({ phase: "available", availableVersion: "0.3.0" })
  expect(screen.getByRole("button", { name: "View update" })).toBeVisible()
})
it("reports a failed native action without exposing its raw rejection", async () => {
  const user = userEvent.setup()
  const { backend } = mount()
  vi.mocked(backend.check).mockRejectedValue(new Error("unfiltered internal paths"))
  await user.click(await screen.findByRole("button", { name: "Check for updates" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("The update action could not finish. Try again.")
  expect(screen.queryByText("unfiltered internal paths")).not.toBeInTheDocument()
})

it("does not overwrite saved automatic-check settings with an older focus refresh", async () => {
  const user = userEvent.setup()
  const { backend } = mount()
  await screen.findByText("Version 0.1.0")
  let resolve!: (value: UpdateSnapshot) => void
  vi.mocked(backend.read).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  fireEvent.focus(window)
  await user.click(screen.getByRole("switch", { name: "Automatically check for updates" }))
  expect(screen.getByRole("switch", { name: "Automatically check for updates" })).not.toBeChecked()
  await act(async () => resolve(state))
  expect(screen.getByRole("switch", { name: "Automatically check for updates" })).not.toBeChecked()
})
it("explains an inspection failure without claiming an operation is still running", async () => {
  mount({ phase: "ready", canInstall: false, installBlockReason: "Silo could not verify sandbox status. Check Sandboxes before updating." })
  expect(await screen.findByText("Silo could not verify sandbox status. Check Sandboxes before updating.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Restart and update" })).toBeDisabled()
  expect(screen.queryByText("Wait for active operations to finish.")).not.toBeInTheDocument()
})
it("keeps installation status visible without offering another update action", async () => {
  mount({ phase: "installing" })
  expect(await screen.findByRole("status")).toHaveTextContent("Installing update. Silo will restart…")
  expect(screen.queryByRole("button", { name: "View update" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument()
})
