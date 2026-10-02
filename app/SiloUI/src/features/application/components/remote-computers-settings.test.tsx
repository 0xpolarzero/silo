import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"

import { ConnectComputerForm, RemoteComputersSettings } from "./remote-computers-settings"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteManagementSchema } from "../model/remote-computers"
import { createComputerUseBridge, type ComputerUseBackend } from "@/desktop/computer-use-bridge"
import { ComputerUseProvider } from "@/desktop/computer-use-provider"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"

function source(remoteManagement: ApplicationSource["remoteManagement"]): ApplicationSource {
  return { ...applicationSourceForScenario("running"), remoteManagement, remoteComputers: [] }
}
function actions(overrides: Partial<ApplicationActions> = {}): ApplicationActions {
  return { connectComputer: vi.fn(), setRemoteManagement: vi.fn(), ...overrides } as unknown as ApplicationActions
}
afterEach(() => { toast.dismiss() })

describe("RemoteComputersSettings", () => {
  it("trims the address and blocks resubmission and cancellation while connecting", async () => {
    let finish!: () => void
    const connect = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const onClose = vi.fn()
    render(<ConnectComputerForm connect={connect} onClose={onClose} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: "  owner@office  " } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    fireEvent.submit(screen.getByRole("form", { name: "Connect computer" }))
    expect(screen.getByRole("textbox", { name: "Computer address" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(connect).toHaveBeenCalledExactlyOnceWith("owner@office")
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each([
    ["authorize", "Authorize SSH in Terminal…"],
    ["setupKey", "Set up Silo SSH key…"],
  ] as const)("retries %s repair and requires an explicit reconnect afterwards", async (kind, label) => {
    let fail!: (error: Error) => void
    const repair = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject })).mockResolvedValueOnce(undefined)
    const connect = vi.fn().mockRejectedValueOnce(new Error("SSH authentication failed")).mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(<ConnectComputerForm connect={connect} onClose={onClose} {...{ [kind]: repair }} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: " owner@office " } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: label }))
    expect(screen.getByRole("button", { name: label })).toBeDisabled()
    expect(repair).toHaveBeenCalledExactlyOnceWith("owner@office")
    await act(async () => fail(new Error("Repair unavailable")))
    expect(screen.getByRole("alert")).toHaveTextContent("Repair unavailable")
    fireEvent.click(screen.getByRole("button", { name: label }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled())
    expect(repair).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(connect).toHaveBeenLastCalledWith("owner@office")
  })

  it("retains a failed removal and retries the same computer after its display name changes", async () => {
    const removeComputer = vi.fn().mockRejectedValueOnce(new Error("Connection could not be removed")).mockResolvedValueOnce(undefined)
    const remote = { id: "office-id", name: "Office", address: "owner@office", connected: false }
    const api = actions({ removeComputer })
    const view = render(<><Toaster /><RemoteComputersSettings source={{ ...source(undefined), remoteComputers: [remote] }} actions={api} /></>)
    fireEvent.click(screen.getByRole("button", { name: "Remove connection to Office" }))
    expect(await screen.findByText("Computer setting not changed")).toBeVisible()
    expect(screen.getByRole("button", { name: "Remove connection to Office" })).toBeEnabled()
    view.rerender(<><Toaster /><RemoteComputersSettings source={{ ...source(undefined), remoteComputers: [{ ...remote, name: "Renamed Office" }] }} actions={api} /></>)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(removeComputer).toHaveBeenCalledTimes(2))
    expect(removeComputer.mock.calls).toEqual([["office-id"], ["office-id"]])
    expect(screen.getByRole("button", { name: "Remove connection to Renamed Office" })).toBeVisible()
  })

  it("explains why remote management does not work on this computer", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "Office Mac", address: "owner@office", error: "Another Silo instance owns remote management." })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Another Silo instance owns remote management.")
    expect(screen.getByRole("switch", { name: "Allow remote management" })).toBeEnabled()
  })

  it("offers every address another computer may reach this one at", async () => {
    const status = remoteManagementSchema.parse({
      enabled: true, hostId: "office", name: "studio", address: "ana@studio.local",
      addresses: [
        { address: "ana@studio.local", kind: "name" },
        { address: "ana@100.101.102.103", kind: "tailscale" },
        { address: "ana@192.168.1.4", kind: "network" },
      ],
    })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    const list = screen.getByRole("list", { name: "Addresses for other computers" })
    expect(within(list).getAllByRole("listitem").map(item => item.textContent)).toEqual([
      expect.stringContaining("ana@studio.local"),
      expect.stringContaining("Tailscale"),
      expect.stringContaining("Local network"),
    ])
    fireEvent.click(within(list).getByRole("button", { name: "Copy ana@100.101.102.103" }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("ana@100.101.102.103"))
  })

  it("falls back to the single address from an older status", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "studio", address: "ana@studio" })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    expect(screen.getByRole("button", { name: "Copy ana@studio" })).toBeInTheDocument()
  })

  it("replaces a saved computer's address only after the user confirms", async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("Office is already saved at office.local. Use 10.0.0.9 for it instead only if that computer moved to this address."))
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(<ConnectComputerForm connect={connect} onClose={onClose} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: "10.0.0.9" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("already saved at office.local")
    expect(connect).toHaveBeenCalledWith("10.0.0.9")
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(connect).toHaveBeenLastCalledWith("10.0.0.9", { replaceAddress: true })
  })

  it("offers no replacement for other connection errors", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("SSH authentication failed."))
    render(<ConnectComputerForm connect={connect} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: "office" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await screen.findByRole("alert")
    expect(screen.queryByRole("button", { name: "Use this address" })).not.toBeInTheDocument()
  })

  it("shows no problem when remote management works", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "Office Mac", address: "owner@office", error: null })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})


it("explains connection removal before it is selected", async () => {
  const removeComputer = vi.fn().mockResolvedValue(undefined)
  const remote = { id: "office", name: "Office", address: "office.example", connected: false, busy: false }
  render(<RemoteComputersSettings source={{ ...source(undefined), remoteComputers: [remote] }} actions={actions({ removeComputer })} />)
  expect(screen.getByText("Removing the connection leaves sandboxes on Office unchanged.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Remove connection to Office" }))
  await waitFor(() => expect(removeComputer).toHaveBeenCalledExactlyOnceWith("office"))
})

describe("ChatGPT for Linux on each computer", () => {
  const HOST = "11111111-1111-4111-8111-111111111111"
  const OFFLINE = "22222222-2222-4222-8222-222222222222"
  const computers = [
    { id: HOST, name: "Office Mac", address: "ana@office", connected: true },
    { id: OFFLINE, name: "Laptop", address: "ana@laptop", connected: false },
  ]
  function settings(statuses: Record<string, unknown>, retry = vi.fn(async (_computer?: string) => ({}))) {
    const reads: Array<string | undefined> = []
    const backend: ComputerUseBackend = {
      readDesktopState: async () => ({}), setApproval: async () => ({}), setup: async () => ({}),
      chatGptStatus: async computer => { reads.push(computer); return statuses[computer ?? "local"] },
      retry, listenStatus: async () => () => {},
    }
    render(<ComputerUseProvider bridge={createComputerUseBridge(backend)}>
      <RemoteComputersSettings source={{ ...source(undefined), remoteComputers: computers }} actions={actions()} />
    </ComputerUseProvider>)
    return { reads, retry }
  }
  const row = (name: string) => within(screen.getByRole("list", { name: "ChatGPT for Linux on each computer" })).getByText(name).closest("li")!

  it("explains the download in one sentence and offers nothing to accept", async () => {
    settings({ local: { state: "ready", path: "/p", version: "26.928.31416" } })
    expect(await screen.findByText("Ready 26.928.31416")).toBeVisible()
    expect(screen.getByText("Silo downloads ChatGPT for Linux from OpenAI so agents in your sandboxes can use the Linux desktop.")).toBeVisible()
    expect(screen.queryByRole("button", { name: /Accept|Not now|Download/ })).not.toBeInTheDocument()
  })

  it("shows each computer's own state, with progress and failure", async () => {
    settings({ local: { state: "downloading", receivedBytes: 42, totalBytes: 100 }, [HOST]: { state: "failed", reason: "Silo could not reach OpenAI.", retryable: true } })
    await waitFor(() => expect(within(row("This computer")).getByRole("status")).toHaveTextContent("Downloading 42%"))
    await waitFor(() => expect(within(row("Office Mac")).getByRole("alert")).toHaveTextContent("Silo could not reach OpenAI."))
    expect(within(row("Office Mac")).getByRole("alert")).toHaveTextContent("tries again automatically")
  })

  it("retries a failed computer by its host id and not through a sandbox", async () => {
    const { retry } = settings({ local: { state: "ready", path: "/p", version: "1" }, [HOST]: { state: "failed", reason: "Offline.", retryable: true } })
    fireEvent.click(await screen.findByRole("button", { name: "Retry ChatGPT for Linux on Office Mac" }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith(HOST))
    expect(screen.getAllByRole("button", { name: /^Retry/ })).toHaveLength(1)
  })

  it("shows an owner on an older Silo, and an offline one, as unknown without errors", async () => {
    const { reads } = settings({ local: { state: "ready", path: "/p", version: "1" }, [HOST]: { state: "notConsented" } })
    await waitFor(() => expect(within(row("Office Mac")).getByText("Unknown")).toBeVisible())
    expect(within(row("Laptop")).getByText(/Unknown · offline/)).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    // An offline computer is not asked.
    expect(reads).not.toContain(OFFLINE)
  })

  it("marks a retained status as last known when a later read fails, keeps older owners unknown, and refreshes on request", async () => {
    let failing = false
    const statuses: Record<string, unknown> = { local: { state: "ready", path: "/p", version: "1" }, [HOST]: { state: "ready", path: "/p", version: "2.0" } }
    const backend: ComputerUseBackend = {
      readDesktopState: async () => ({}), setApproval: async () => ({}), setup: async () => ({}),
      chatGptStatus: async computer => { if (computer && failing) throw new Error("SSH connection lost."); return statuses[computer ?? "local"] },
      retry: async () => ({}), listenStatus: async () => () => {},
    }
    render(<ComputerUseProvider bridge={createComputerUseBridge(backend, { busy: 20, idle: 20 })}>
      <RemoteComputersSettings source={{ ...source(undefined), remoteComputers: computers }} actions={actions()} />
    </ComputerUseProvider>)
    expect(await screen.findByText("Ready 2.0")).toBeVisible()
    failing = true
    await waitFor(() => expect(within(row("Office Mac")).getByRole("alert")).toHaveTextContent("Could not refresh: SSH connection lost."))
    expect(within(row("Office Mac")).getByText("Last known: Ready 2.0")).toBeVisible()
    expect(within(row("This computer")).queryByText(/Last known/)).not.toBeInTheDocument()
    failing = false
    fireEvent.click(within(row("Office Mac")).getByRole("button", { name: "Refresh ChatGPT for Linux status on Office Mac" }))
    await waitFor(() => expect(within(row("Office Mac")).queryByRole("alert")).not.toBeInTheDocument())
    expect(within(row("Office Mac")).getByText("Ready 2.0")).toBeVisible()
    // An owner on an older Silo stays Unknown, with or without a failed read.
    statuses[HOST] = { state: "notConsented" }
    await waitFor(() => expect(within(row("Office Mac")).getByText("Unknown")).toBeVisible())
    failing = true
    await waitFor(() => expect(within(row("Office Mac")).getByRole("alert")).toBeVisible())
    expect(within(row("Office Mac")).getByText("Unknown")).toBeVisible()
    expect(within(row("Office Mac")).queryByText(/Last known/)).not.toBeInTheDocument()
  })
})


it("stops subscription recovery timers when computer settings become inactive", async () => {
  vi.useFakeTimers()
  const listen = vi.fn().mockRejectedValue(new Error("Event bridge unavailable"))
  const read = vi.fn().mockResolvedValue({ state: "downloading", receivedBytes: 1, totalBytes: 10 })
  const backend: ComputerUseBackend = {
    readDesktopState: vi.fn(), setApproval: vi.fn(), setup: vi.fn(), retry: vi.fn(),
    chatGptStatus: read, listenStatus: listen,
  }
  const bridge = createComputerUseBridge(backend)
  const settings = (active: boolean) => <ComputerUseProvider bridge={bridge}>
    <RemoteComputersSettings source={source(undefined)} actions={actions()} active={active} />
  </ComputerUseProvider>
  const view = render(settings(true))
  try {
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByRole("alert")).toHaveTextContent("Event bridge unavailable")
    expect(screen.getByRole("button", { name: "Refresh ChatGPT for Linux status on This computer" })).toBeEnabled()
    view.rerender(settings(false))
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(listen).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    view.rerender(settings(true))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(listen).toHaveBeenCalledTimes(2)
  } finally { view.unmount(); vi.useRealTimers() }
})
