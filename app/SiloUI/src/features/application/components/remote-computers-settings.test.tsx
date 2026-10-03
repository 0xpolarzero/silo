import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import userEvent from "@testing-library/user-event"
import { Toaster } from "@/components/ui/sonner"

import { ConnectComputerForm, RemoteComputersSettings } from "./remote-computers-settings"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteManagementSchema } from "../model/remote-computers"
import { createComputerUseBridge, type ComputerUseBackend } from "@/desktop/computer-use-bridge"
import { ComputerUseProvider } from "@/desktop/computer-use-provider"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"

function source(remoteManagement: ApplicationSource["remoteManagement"]): ApplicationSource {
  return { ...applicationSourceForScenario("running"), remoteManagement, remoteComputers: [] }
}
function actions(overrides: Partial<ApplicationActions> = {}): ApplicationActions {
  return { connectComputer: vi.fn(), setRemoteManagement: vi.fn(), ...overrides } as unknown as ApplicationActions
}
afterEach(() => { toast.dismiss() })

describe("RemoteComputersSettings", () => {
  it("disables connection removal when the adapter does not provide it", () => {
    const remote = { id: "office", name: "Office", address: "office.example", connected: false }
    render(<RemoteComputersSettings source={{ ...source(undefined), remoteComputers: [remote] }} actions={actions()} />)
    expect(screen.getByRole("button", { name: "Remove connection to Office" })).toBeDisabled()
  })

  it("reveals the complete name of a computer with a long SSH address", () => {
    const name = "Office workstation ".repeat(20).trim()
    const remote = { id: "office-id", name, address: `${"account".repeat(30)}@office.example`, connected: false }
    render(<RemoteComputersSettings source={{ ...source(undefined), remoteComputers: [remote] }} actions={actions()} />)
    expect(screen.getByText(name)).toHaveAttribute("title", name)
  })

  it.each(["cancel", "connect"])("returns focus to the opening button after %s", async (close) => {
    const user = userEvent.setup()
    const connectComputer = vi.fn().mockResolvedValue(undefined)
    render(<RemoteComputersSettings source={source(undefined)} actions={actions({ connectComputer })} />)
    await user.click(screen.getByRole("button", { name: "Connect computer…" }))
    const address = screen.getByRole("textbox", { name: "Computer address" })
    expect(address).toHaveFocus()
    if (close === "cancel") await user.click(screen.getByRole("button", { name: "Cancel" }))
    else {
      await user.type(address, "owner@office")
      await user.click(screen.getByRole("button", { name: "Connect" }))
      expect(connectComputer).toHaveBeenCalledExactlyOnceWith("owner@office")
    }
    expect(await screen.findByRole("button", { name: "Connect computer…" })).toHaveFocus()
  })

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
    ["authorize", "Authorize SSH in Terminal…", "Opening Terminal…"],
    ["setupKey", "Set up Silo SSH key…", "Setting up SSH key…"],
  ] as const)("retries %s repair and requires an explicit reconnect afterwards", async (kind, label, progress) => {
    let fail!: (error: Error) => void
    const repair = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject })).mockResolvedValueOnce(undefined)
    const connect = vi.fn().mockRejectedValueOnce(new Error("SSH authentication failed")).mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(<ConnectComputerForm connect={connect} onClose={onClose} {...{ [kind]: repair }} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: " owner@office " } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: label }))
    expect(screen.getByRole("button", { name: progress })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Connecting…" })).not.toBeInTheDocument()
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
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
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
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("ana@100.101.102.103"))
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

describe("Computer use components", () => {
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
  const section = () => screen.queryByRole("region", { name: "Computer use components" })
  const row = (name: string) => within(screen.getByRole("list", { name: "Computers that need attention" })).getByText(name).closest("li")!

  it("shows nothing while every computer prepares ChatGPT for Linux, ready or not", async () => {
    const { reads } = settings({ local: { state: "downloading", receivedBytes: 42, totalBytes: 100 }, [HOST]: { state: "ready", path: "/p", version: "1" } })
    await waitFor(() => expect(reads).toContain(HOST))
    await waitFor(() => expect(reads).toContain(undefined))
    expect(section()).not.toBeInTheDocument()
    expect(screen.queryByText(/ChatGPT for Linux/)).not.toBeInTheDocument()
    // An offline computer is not asked.
    expect(reads).not.toContain(OFFLINE)
  })

  it("lists only the computers with a failed download, with the reason and the disclosure", async () => {
    settings({ local: { state: "ready", path: "/p", version: "1" }, [HOST]: { state: "failed", reason: "Silo could not reach OpenAI.", retryable: true } })
    expect(await screen.findByRole("region", { name: "Computer use components" })).toBeVisible()
    expect(within(row("Office Mac")).getByRole("alert")).toHaveTextContent("Silo could not reach OpenAI. Silo tries again automatically.")
    expect(screen.queryByText("This computer")).not.toBeInTheDocument()
    expect(screen.getByText("Silo downloads ChatGPT for Linux from OpenAI so agents in your sandboxes can use the Linux desktop.")).toBeVisible()
    expect(screen.queryByRole("button", { name: /Accept|Not now|Download/ })).not.toBeInTheDocument()
  })

  it("retries a failed computer by its host id and not through a sandbox", async () => {
    const { retry } = settings({ local: { state: "ready", path: "/p", version: "1" }, [HOST]: { state: "failed", reason: "Offline.", retryable: true } })
    fireEvent.click(await screen.findByRole("button", { name: "Retry ChatGPT for Linux on Office Mac" }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith(HOST))
    expect(screen.getAllByRole("button", { name: /^Retry/ })).toHaveLength(1)
  })

  it("treats an owner on an older Silo as no problem", async () => {
    const { reads } = settings({ local: { state: "ready", path: "/p", version: "1" }, [HOST]: { state: "notConsented" } })
    await waitFor(() => expect(reads).toContain(HOST))
    expect(section()).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("reveals the complete name of a computer with a problem", async () => {
    settings({ local: { state: "ready", path: "/p", version: "1" }, [HOST]: { state: "failed", reason: "Offline.", retryable: true } })
    await screen.findByRole("region", { name: "Computer use components" })
    expect(within(row("Office Mac")).getByText("Office Mac")).toHaveAttribute("title", "Office Mac")
  })

  it("offers Refresh for a status that cannot be read and clears once it can", async () => {
    let failing = true
    const backend: ComputerUseBackend = {
      readDesktopState: async () => ({}), setApproval: async () => ({}), setup: async () => ({}),
      chatGptStatus: async computer => { if (computer && failing) throw new Error("SSH connection lost."); return { state: "ready", path: "/p", version: "1" } },
      retry: async () => ({}), listenStatus: async () => () => {},
    }
    render(<ComputerUseProvider bridge={createComputerUseBridge(backend, { busy: 20000, idle: 20000 })}>
      <RemoteComputersSettings source={{ ...source(undefined), remoteComputers: computers }} actions={actions()} />
    </ComputerUseProvider>)
    await waitFor(() => expect(within(row("Office Mac")).getByRole("alert")).toHaveTextContent("SSH connection lost."))
    expect(screen.queryByRole("button", { name: /^Retry/ })).not.toBeInTheDocument()
    failing = false
    fireEvent.click(within(row("Office Mac")).getByRole("button", { name: "Refresh ChatGPT for Linux status on Office Mac" }))
    await waitFor(() => expect(section()).not.toBeInTheDocument())
  })
})

describe("New sandbox approval default", () => {
  function withBridge(store = createMemorySettingsStore()) {
    const backend: ComputerUseBackend = {
      readDesktopState: async () => ({}), setApproval: async () => ({}), setup: async () => ({}),
      chatGptStatus: async () => ({ state: "ready", path: "/p", version: "1" }), retry: async () => ({}), listenStatus: async () => () => {},
    }
    render(<SettingsProvider store={store}><ComputerUseProvider bridge={createComputerUseBridge(backend)}>
      <RemoteComputersSettings source={source(undefined)} actions={actions()} />
    </ComputerUseProvider></SettingsProvider>)
    return store
  }

  it("is off by default and saves the choice", async () => {
    const store = withBridge()
    const toggle = screen.getByRole("switch", { name: "Allow agents to use the computer without asking in new sandboxes" })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText("Claude Code, Codex and similar agents stop asking before using the sandbox’s desktop. Not a security boundary.")).toBeVisible()
    fireEvent.click(toggle)
    await waitFor(() => expect(store.getSnapshot().settings.computerUseAutoApproval).toBe(true))
    expect(toggle).toBeChecked()
  })

  it("is not offered when this build has no built-in computer use", () => {
    render(<RemoteComputersSettings source={source(undefined)} actions={actions()} />)
    expect(screen.queryByRole("switch", { name: /without asking/ })).not.toBeInTheDocument()
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


it("blocks removal Retry while a remote management change is pending", async () => {
  let finish!: () => void
  const setRemoteManagement = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const removeComputer = vi.fn().mockRejectedValueOnce(new Error("Connection could not be removed")).mockResolvedValue(undefined)
  const remote = { id: "office", name: "Office", address: "owner@office", connected: false }
  const management = remoteManagementSchema.parse({ enabled: true, hostId: "local", name: "This computer", address: "owner@local" })
  render(<><Toaster /><RemoteComputersSettings source={{ ...source(management), remoteComputers: [remote] }} actions={actions({ setRemoteManagement, removeComputer })} /></>)
  fireEvent.click(screen.getByRole("button", { name: "Remove connection to Office" }))
  const retry = await screen.findByRole("button", { name: "Retry" })
  const toggle = screen.getByRole("switch", { name: "Allow remote management" })
  fireEvent.click(toggle)
  expect(toggle).toBeDisabled()
  await act(async () => fireEvent.click(retry))
  expect(removeComputer).toHaveBeenCalledOnce()
  expect(toggle).toBeDisabled()
  await act(async () => finish())
  expect(toggle).toBeEnabled()
})


it("ignores an obsolete management Retry after a newer choice succeeds", async () => {
  const user = userEvent.setup()
  const management = { enabled: false, hostId: "local", name: "Laptop", address: "owner@laptop" }
  const setRemoteManagement = vi.fn().mockRejectedValueOnce(new Error("Reply unavailable")).mockResolvedValue(undefined)
  const api = actions({ setRemoteManagement })
  const view = (enabled: boolean) => <><Toaster /><RemoteComputersSettings source={source({ ...management, enabled })} actions={api} /></>
  const { rerender } = render(view(false))
  await user.click(screen.getByRole("switch", { name: "Allow remote management" }))
  const retry = await screen.findByRole("button", { name: "Retry" })
  rerender(view(true))
  await user.click(screen.getByRole("switch", { name: "Allow remote management" }))
  await waitFor(() => expect(screen.getByRole("switch", { name: "Allow remote management" })).toBeEnabled())
  await user.click(retry)
  expect(setRemoteManagement).toHaveBeenCalledTimes(2)
  expect(setRemoteManagement).toHaveBeenLastCalledWith(false)
})

it("keeps a removal Retry after unrelated computer changes succeed", async () => {
  const user = userEvent.setup()
  const management = { enabled: false, hostId: "local", name: "Laptop", address: "owner@laptop" }
  const setRemoteManagement = vi.fn().mockResolvedValue(undefined)
  const removeComputer = vi.fn().mockRejectedValueOnce(new Error("Connection could not be removed")).mockResolvedValue(undefined)
  const remotes = [{ id: "office", name: "Office", address: "owner@office", connected: false }, { id: "lab", name: "Lab", address: "owner@lab", connected: false }]
  render(<><Toaster /><RemoteComputersSettings source={{ ...source(management), remoteComputers: remotes }} actions={actions({ setRemoteManagement, removeComputer })} /></>)
  await user.click(screen.getByRole("button", { name: "Remove connection to Office" }))
  const retry = await screen.findByRole("button", { name: "Retry" })
  await user.click(screen.getByRole("switch", { name: "Allow remote management" }))
  await waitFor(() => expect(screen.getByRole("switch", { name: "Allow remote management" })).toBeEnabled())
  await user.click(screen.getByRole("button", { name: "Remove connection to Lab" }))
  await waitFor(() => expect(removeComputer).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByRole("switch", { name: "Allow remote management" })).toBeEnabled())
  await user.click(retry)
  expect(removeComputer).toHaveBeenCalledTimes(3)
  expect(removeComputer).toHaveBeenLastCalledWith("office")
})

it("ignores a computer setting Retry after the settings controls unmount", async () => {
  const user = userEvent.setup()
  const management = { enabled: false, hostId: "local", name: "Laptop", address: "owner@laptop" }
  const setRemoteManagement = vi.fn().mockRejectedValue(new Error("Reply unavailable"))
  const { rerender } = render(<><Toaster /><RemoteComputersSettings source={source(management)} actions={actions({ setRemoteManagement })} /></>)
  await user.click(screen.getByRole("switch", { name: "Allow remote management" }))
  const retry = await screen.findByRole("button", { name: "Retry" })
  rerender(<Toaster />)
  await user.click(retry)
  expect(setRemoteManagement).toHaveBeenCalledOnce()
})


it.each([false, true])("ignores connection completion after its form unmounts (replace=%s)", async replace => {
  let finish!: () => void
  const connect = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  if (replace) connect.mockRejectedValueOnce(new Error("Office is already saved at owner@old-office"))
  const onClose = vi.fn()
  const { unmount } = render(<ConnectComputerForm connect={connect} onClose={onClose} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Computer address" }), { target: { value: "owner@office" } })
  fireEvent.submit(screen.getByRole("form", { name: "Connect computer" }))
  if (replace) {
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }))
  }
  unmount()
  await act(async () => finish())
  expect(onClose).not.toHaveBeenCalled()
})
