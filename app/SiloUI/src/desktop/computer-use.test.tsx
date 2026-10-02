import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "@/features/sandboxes/components/machine-list"
import { computerUseFixtureNames, createFixtureComputerUseBackend, fixtureChatGptStatus, fixtureComputerUse, fixtureDesktopState } from "@/fixtures/computer-use"
import { ComputerUseProvider, computerOfWorkspace, createComputerUseBridge, type ComputerUseBackend } from "./computer-use-bridge"
import { CHATGPT_DOWNLOAD_NOTE, ChatGptAppProgress, ChatGptAppStatusView, ComputerUsePanel, ComputerUseSection, chatGptStatusText, computerUseLabel } from "./computer-use-panel"
import { LinuxDesktopViewer } from "./linux-desktop-viewer"
import { chatGptAppStatusSchema, parseChatGptAppStatus, parseLinuxDesktopState, type ComputerUseState, type LinuxDesktopState } from "./linux-desktop-state"

const ready = fixtureComputerUse("ready")

function backend(overrides: Partial<ComputerUseBackend> = {}): ComputerUseBackend {
  const base = createFixtureComputerUseBackend("ready", "idle")
  return { ...base, ...overrides }
}
const wrap = (bridgeBackend: ComputerUseBackend, children: React.ReactNode) =>
  <ComputerUseProvider bridge={createComputerUseBridge(bridgeBackend)}>{children}</ComputerUseProvider>

describe("computer use schemas", () => {
  const desktop = { installed: true, autoStart: true, state: "running" }
  it("parses the computerUse object of a v4 VM", () => {
    const parsed = parseLinuxDesktopState({ ...desktop, computerUse: { ...ready, agents: ["Codex"] } })
    expect(parsed.computerUse).toMatchObject({ state: "ready", approval: "ask", compatibility: "tested", appVersion: "26.928.31416", agents: ["Codex"] })
  })
  it("leaves older VMs without computerUse", () => {
    expect(parseLinuxDesktopState({ ...desktop, lcuState: "ready" }).computerUse).toBeUndefined()
  })
  it("tolerates unknown or malformed diagnostics without losing the desktop state", () => {
    const parsed = parseLinuxDesktopState({ ...desktop, computerUse: { state: "rebooting", compatibility: "maybe", approval: "sometimes", agents: "none", appVersion: 7, extra: true } })
    expect(parsed.state).toBe("running")
    expect(parsed.computerUse).toMatchObject({ state: "unavailable", compatibility: "unknown", approval: "unknown", agents: null, appVersion: null })
    expect(parseLinuxDesktopState({ ...desktop, computerUse: "broken" }).computerUse).toBeNull()
  })
  it.each([
    [{ state: "unknown" }], [{ state: "idle" }], [{ state: "downloading", receivedBytes: 1, totalBytes: 2 }], [{ state: "verifying" }],
    [{ state: "extracting" }], [{ state: "ready", path: "/p", version: "1" }], [{ state: "failed", reason: "x", retryable: true }],
  ])("parses ChatGPT app status %j", status => { expect(chatGptAppStatusSchema.parse(status)).toMatchObject(status) })
  it("tolerates detail fields but rejects an unknown status", () => {
    expect(chatGptAppStatusSchema.parse({ state: "downloading", receivedBytes: "many" })).toMatchObject({ receivedBytes: 0 })
    expect(chatGptAppStatusSchema.safeParse({ state: "mystery" }).success).toBe(false)
  })
  it("reads a state it does not know, such as an older Silo's notConsented, as unknown rather than an error", () => {
    expect(parseChatGptAppStatus({ state: "notConsented" })).toEqual({ state: "unknown" })
    expect(parseChatGptAppStatus({ state: "from-the-future" })).toEqual({ state: "unknown" })
    expect(parseChatGptAppStatus({ state: "idle" })).toEqual({ state: "idle" })
    expect(parseChatGptAppStatus("garbage")).toBeNull()
  })
  it("has no consent state in computer use either", () => {
    expect(parseLinuxDesktopState({ installed: true, autoStart: true, state: "running", computerUse: { state: "needs-consent" } }).computerUse?.state).toBe("unavailable")
    expect(computerUseFixtureNames).not.toContain("needs-consent")
  })
})

describe("computer use panel", () => {
  function panel(computerUse: ComputerUseState, extra: Partial<Parameters<typeof ComputerUsePanel>[0]> = {}) {
    const onApproval = vi.fn()
    const onSetup = vi.fn()
    render(<ComputerUsePanel computerUse={computerUse} running busy={false} error={null} onApproval={onApproval} onSetup={onSetup} {...extra} />)
    return { onApproval, onSetup }
  }
  it.each(computerUseFixtureNames.filter(name => !["untested", "auto", "pre-v4"].includes(name)))("shows the %s state and its reason", name => {
    const state = fixtureComputerUse(name)
    panel(state)
    expect(screen.getByRole("region", { name: "Computer use" })).toHaveTextContent(computerUseLabel(state.state, state.cause))
    if (state.reason) expect(screen.getByText(state.reason)).toBeVisible()
  })
  it("announces work in progress", () => {
    panel(fixtureComputerUse("installing"))
    expect(screen.getByRole("status")).toHaveTextContent("Installing")
  })
  it("keeps versions in a details disclosure", () => {
    panel(ready)
    const details = screen.getByText("Details").closest("details")!
    expect(details).not.toHaveAttribute("open")
    expect(within(details).getByText("26.928.31416")).toBeInTheDocument()
    expect(within(details).getByText("0.8.0")).toBeInTheDocument()
    expect(within(details).getByText("Claude Code, Codex")).toBeInTheDocument()
  })
  it("warns without blocking when the pair is untested", async () => {
    const { onApproval } = panel(fixtureComputerUse("untested"))
    expect(screen.getByRole("note")).toHaveTextContent("has not been tested")
    await userEvent.setup().click(screen.getByRole("switch", { name: /Allow without asking/ }))
    expect(onApproval).toHaveBeenCalledWith("auto")
  })
  it("shows no warning for a tested pair", () => {
    panel(ready)
    expect(screen.queryByRole("note")).not.toBeInTheDocument()
  })
  it("binds the switch to the approval mode", async () => {
    const user = userEvent.setup()
    const { onApproval } = panel({ ...ready, approval: "auto" })
    const toggle = screen.getByRole("switch", { name: /Allow without asking/ })
    expect(toggle).toBeChecked()
    expect(screen.getByText(/stop asking in this sandbox/)).toBeVisible()
    await user.click(toggle)
    expect(onApproval).toHaveBeenCalledWith("ask")
  })
  it("sets up computer use only while the desktop runs", async () => {
    const user = userEvent.setup()
    const { onSetup } = panel(ready)
    await user.click(screen.getByRole("button", { name: "Set up computer use" }))
    expect(onSetup).toHaveBeenCalledOnce()
  })
  it("disables setup when stopped, installing or busy", () => {
    const { unmount } = render(<ComputerUsePanel computerUse={ready} running={false} busy={false} error={null} onApproval={vi.fn()} onSetup={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Set up computer use" })).toBeDisabled()
    unmount()
    render(<ComputerUsePanel computerUse={fixtureComputerUse("installing")} running busy={false} error={null} onApproval={vi.fn()} onSetup={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Set up computer use" })).toBeDisabled()
  })
  it("shows errors from the owning computer as they came", () => {
    panel(ready, { error: "Computer disconnected: office-mac" })
    expect(screen.getByRole("alert")).toHaveTextContent("Computer disconnected: office-mac")
  })
})

describe("ChatGPT app progress, read-only", () => {
  it("shows nothing without a store", () => {
    render(wrap(backend(), <ChatGptAppStatusView store={undefined} />))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("group")).not.toBeInTheDocument()
  })
  it("has no notice, consent or buttons to accept, whatever the state", async () => {
    for (const status of [{ state: "idle" }, { state: "downloading", receivedBytes: 1, totalBytes: 2 }, { state: "failed", reason: "Offline.", retryable: true }, { state: "unknown" }]) {
      const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => status }))
      const { unmount } = render(<ChatGptAppStatusView store={bridge.chatGptFor()} />)
      await waitFor(() => expect(bridge.chatGptFor().getSnapshot().status).not.toBeNull())
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
      expect(screen.queryByText(/Accept|Not now|terms of use|Download ChatGPT for Linux\?/)).not.toBeInTheDocument()
      unmount()
    }
  })
  it("follows chatgpt-app-status events from waiting through download to ready", async () => {
    let emit!: (status: unknown) => void
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "idle" }), listenStatus: async handler => { emit = handler; return () => {} } }))
    render(<ChatGptAppStatusView store={bridge.chatGptFor()} />)
    await screen.findByText("ChatGPT for Linux will download shortly.")
    await waitFor(() => expect(emit).toBeDefined())
    act(() => emit({ state: "downloading", receivedBytes: 100_000_000, totalBytes: 450_000_000 }))
    expect(screen.getByRole("status")).toHaveTextContent("100 MB of 450 MB")
    expect(screen.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("aria-valuenow", "22")
    act(() => emit({ state: "verifying" }))
    expect(screen.getByRole("status")).toHaveTextContent("Verifying")
    act(() => emit({ state: "extracting" }))
    expect(screen.getByRole("status")).toHaveTextContent("Unpacking")
    act(() => emit({ state: "failed", reason: "The connection was interrupted.", retryable: true }))
    expect(screen.getByRole("alert")).toHaveTextContent("The connection was interrupted.")
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
    act(() => emit({ state: "ready", path: "/p", version: "26.928.31416" }))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("offers Retry only where the caller provides it, and ignores events it cannot read", async () => {
    const onRetry = vi.fn()
    render(<ChatGptAppProgress status={{ state: "failed", reason: "Checksum mismatch.", retryable: false }} onRetry={onRetry} />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
    let emit!: (status: unknown) => void
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "failed", reason: "Offline.", retryable: true }), listenStatus: async handler => { emit = handler; return () => {} } }))
    render(<ChatGptAppStatusView store={bridge.chatGptFor()} />)
    await screen.findByText("Offline.")
    act(() => emit({ state: "from-the-future" }))
    expect(screen.getByText("Offline.")).toBeVisible()
  })
  it("summarizes each state in one line", () => {
    expect(chatGptStatusText({ state: "ready", path: null, version: "26.928.31416" })).toBe("Ready 26.928.31416")
    expect(chatGptStatusText({ state: "downloading", receivedBytes: 42, totalBytes: 100 })).toBe("Downloading 42%")
    expect(chatGptStatusText({ state: "failed", reason: "x", retryable: true })).toBe("Failed")
    expect(chatGptStatusText({ state: "unknown" })).toBe("Unknown")
    expect(chatGptStatusText(null)).toBe("Unknown")
    expect(CHATGPT_DOWNLOAD_NOTE).toBe("Silo downloads ChatGPT for Linux from OpenAI so agents in your sandboxes can use the Linux desktop.")
  })
})

describe("computer use section", () => {
  function section(b: ComputerUseBackend) {
    render(wrap(b, <ComputerUseSection workspace="office/vm-1" pollMs={60_000} />))
  }
  it("sets the approval mode through the owning computer's command and shows the result", async () => {
    const setApproval = vi.fn(async (_workspace: string, mode: "ask" | "auto") => ({ ...fixtureDesktopState("ready"), computerUse: { ...ready, approval: mode } }))
    section(backend({ readDesktopState: async () => fixtureDesktopState("ready"), setApproval }))
    const toggle = await screen.findByRole("switch", { name: /Allow without asking/ })
    expect(toggle).not.toBeChecked()
    await userEvent.setup().click(toggle)
    await waitFor(() => expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeChecked())
    expect(setApproval).toHaveBeenCalledWith("office/vm-1", "auto")
  })
  it("reverts and reports a failed approval change", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("ready"), setApproval: async () => { throw new Error("office-mac is offline") } }))
    await userEvent.setup().click(await screen.findByRole("switch", { name: /Allow without asking/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("office-mac is offline")
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).not.toBeChecked()
  })
  it("runs setup-computer-use and reports ready", async () => {
    const setup = vi.fn(async () => fixtureDesktopState("ready"))
    section(backend({ readDesktopState: async () => fixtureDesktopState("failed"), setup }))
    await screen.findByText("Setup failed")
    await userEvent.setup().click(screen.getByRole("button", { name: "Set up computer use" }))
    await waitFor(() => expect(screen.getByText("Ready")).toBeVisible())
    expect(setup).toHaveBeenCalledWith("office/vm-1")
  })
  it("shows the read-only download progress while the app is preparing, with no buttons to accept", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("preparing"), chatGptStatus: async () => ({ state: "downloading", receivedBytes: 187_000_000, totalBytes: 453_000_000 }) }))
    expect(await screen.findByText(/187 MB of 453 MB/)).toBeVisible()
    expect(screen.queryByRole("button", { name: /Accept|Not now|Retry|Download/ })).not.toBeInTheDocument()
  })
  it("announces that setup finished and tells running agent sessions to reconnect", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("failed"), setup: async () => fixtureDesktopState("ready") }))
    await screen.findByText("Setup failed")
    await userEvent.setup().click(screen.getByRole("button", { name: "Set up computer use" }))
    expect(await screen.findByRole("status")).toHaveTextContent("Reconnect agent sessions to load computer use.")
  })
  it("does not announce success when setup fails", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("failed"), setup: async () => { throw new Error("The sandbox stopped.") } }))
    await screen.findByText("Setup failed")
    await userEvent.setup().click(screen.getByRole("button", { name: "Set up computer use" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("The sandbox stopped.")
    expect(screen.queryByText(/Reconnect agent sessions/)).not.toBeInTheDocument()
  })
  it("tells a failed ChatGPT download from a failed setup, and retries the download on the owning computer", async () => {
    const retry = vi.fn(async (_computer?: string) => ({}))
    section(backend({ readDesktopState: async () => fixtureDesktopState("app-failed"), chatGptStatus: async () => fixtureChatGptStatus("failed-final"), retry }))
    expect(await screen.findByText("Download failed")).toBeVisible()
    expect(await screen.findByRole("button", { name: "Retry" })).toBeEnabled()
    // Setting up the guest cannot fix the host download.
    expect(screen.getByRole("button", { name: "Set up computer use" })).toBeDisabled()
    expect(screen.getAllByText(/did not match the expected checksum/)).toHaveLength(1)
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
  })
  it("keeps a guest setup failure on Set up computer use, without a download Retry", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("failed"), chatGptStatus: async () => fixtureChatGptStatus("ready") }))
    expect(await screen.findByText("Setup failed")).toBeVisible()
    expect(screen.getByRole("button", { name: "Set up computer use" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })
  it("renders nothing for a pre-v4 sandbox", async () => {
    const read = vi.fn(async () => fixtureDesktopState("pre-v4"))
    section(backend({ readDesktopState: read }))
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(screen.queryByRole("region", { name: "Computer use" })).not.toBeInTheDocument()
  })
  it("renders nothing without a bridge", () => {
    render(<ComputerUseSection workspace="dev" />)
    expect(screen.queryByRole("region", { name: "Computer use" })).not.toBeInTheDocument()
  })
})

describe("v3 and v4 desktop viewer", () => {
  function viewer(state: LinuxDesktopState) {
    const onAction = vi.fn()
    render(<LinuxDesktopViewer name="dev" state={state} busy={false} error={null} onAction={onAction} onRetry={vi.fn()} onFullscreen={vi.fn()} />)
    return onAction
  }
  it("offers legacy LCU setup only for older sandboxes", async () => {
    const onAction = viewer(fixtureDesktopState("pre-v4"))
    await userEvent.setup().click(screen.getByRole("button", { name: "Set up LCU" }))
    expect(onAction).toHaveBeenCalledWith("setup-lcu")
    expect(screen.queryByRole("button", { name: "Set up computer use" })).not.toBeInTheDocument()
  })
  it("shows computer use status and its setup action for v4 sandboxes", async () => {
    const onAction = viewer(fixtureDesktopState("ready"))
    expect(screen.getByText("Computer use: Ready")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Set up LCU" })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "Set up computer use" }))
    expect(onAction).toHaveBeenCalledWith("setup-computer-use")
  })
  it("hides setup while computer use is installing", () => {
    viewer(fixtureDesktopState("installing"))
    expect(screen.getByRole("status")).toHaveTextContent("Computer use: Installing")
    expect(screen.queryByRole("button", { name: "Set up computer use" })).not.toBeInTheDocument()
  })
  it("does not send a v4 sandbox to Add Linux desktop", () => {
    viewer({ ...fixtureDesktopState("ready"), state: "uninstalled", installed: false })
    expect(screen.queryByText(/Add Linux desktop/)).not.toBeInTheDocument()
    expect(screen.getByText("Desktop unavailable")).toBeVisible()
  })
  it("still points an older sandbox to Add Linux desktop", () => {
    viewer({ installed: false, autoStart: false, state: "uninstalled" })
    expect(screen.getByText(/Add Linux desktop/)).toBeVisible()
  })
})

describe("sandbox settings for v3 and v4", () => {
  const machine = productionMachineDefaults[0]
  function editor(draft: typeof machine, created: boolean, provider: boolean) {
    const list = <TooltipProvider><MachineList machines={created ? [draft] : []} onMachinesChange={vi.fn()}
      isMachineCreated={() => created} isMachineRunning={() => created}
      initialEditorDraft={{ draft, originalID: created ? draft.id : undefined, insertAt: 0 }} /></TooltipProvider>
    render(provider ? wrap(backend(), list) : list)
  }
  it("replaces the desktop controls of a built-in sandbox with a note", () => {
    editor({ ...machine, desktop: { startWithSandbox: true, builtIn: true } }, true, true)
    expect(screen.queryByRole("switch", { name: "Start desktop with sandbox" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add Linux desktop" })).not.toBeInTheDocument()
    expect(screen.getByText("Built in. The desktop starts with the sandbox.")).toBeVisible()
  })
  it("keeps the startup switch for a sandbox created before v4", () => {
    editor({ ...machine, desktop: { startWithSandbox: true } }, true, true)
    expect(screen.getByRole("switch", { name: "Start desktop with sandbox" })).toBeVisible()
  })
  it("keeps Add Linux desktop for an older sandbox without a desktop", () => {
    editor(machine, true, true)
    expect(screen.getByRole("button", { name: "Add Linux desktop" })).toBeVisible()
  })
  it("shows no download notice or consent when creating a sandbox, and saving is never blocked", async () => {
    editor(machine, false, true)
    expect(screen.queryByRole("checkbox", { name: "Linux desktop" })).not.toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Download ChatGPT for Linux?" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Accept|Not now/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })
  it("keeps the desktop checkbox without computer use support", () => {
    editor(machine, false, false)
    expect(screen.getByRole("checkbox", { name: "Linux desktop" })).toBeVisible()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const HOST = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const VM = "33333333-3333-4333-8333-333333333333"
const remoteVm = `silo-remote:${HOST}:${VM}`

describe("ChatGPT app store per computer", () => {
  it("addresses a computer by its host id, never a placeholder sandbox, and keeps one store per computer", async () => {
    const calls: Array<[string, string | undefined]> = []
    const bridge = createComputerUseBridge(backend({
      chatGptStatus: async computer => { calls.push(["status", computer]); return { state: "failed", reason: "Offline.", retryable: true } },
      retry: async computer => { calls.push(["retry", computer]) },
    }))
    expect(bridge.chatGptFor()).toBe(bridge.chatGptFor())
    expect(bridge.chatGptFor(HOST)).toBe(bridge.chatGptFor(computerOfWorkspace(remoteVm)))
    expect(bridge.chatGptFor(HOST)).not.toBe(bridge.chatGptFor())
    expect(bridge.chatGptFor(HOST)).not.toBe(bridge.chatGptFor(OTHER))
    await bridge.chatGptFor(HOST).retry()
    await bridge.chatGptFor().refresh()
    expect(calls.filter(([name]) => name === "retry")).toEqual([["retry", HOST]])
    expect(calls.at(-1)).toEqual(["status", undefined])
    expect(JSON.stringify(calls)).not.toContain("silo-remote")
  })
  it("finds the owning computer of a sandbox", () => {
    expect(computerOfWorkspace(remoteVm)).toBe(HOST)
    expect(computerOfWorkspace("dev")).toBeUndefined()
    expect(computerOfWorkspace(undefined)).toBeUndefined()
  })
  it("applies a status event only to this computer", async () => {
    const handlers: Array<(payload: unknown) => void> = []
    const emit = (payload: unknown) => handlers.forEach(handler => handler(payload))
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "idle" }), listenStatus: async handler => { handlers.push(handler); return () => {} } }), { busy: 60_000, idle: 60_000 })
    const local = bridge.chatGptFor()
    const remote = bridge.chatGptFor(HOST)
    const unsubscribe = [local, remote].map(store => store.subscribe(() => {}))
    await waitFor(() => expect(remote.getSnapshot().status).toEqual({ state: "idle" }))
    act(() => emit({ state: "downloading", receivedBytes: 5, totalBytes: 10 }))
    expect(local.getSnapshot().status).toMatchObject({ state: "downloading" })
    expect(remote.getSnapshot().status).toEqual({ state: "idle" })
    unsubscribe.forEach(stop => stop())
  })
  it("reads a remote computer's status again on a schedule, faster while it works", async () => {
    const statuses: unknown[] = [{ state: "downloading", receivedBytes: 1, totalBytes: 10 }, { state: "downloading", receivedBytes: 5, totalBytes: 10 }, { state: "ready", path: "/p", version: "1" }]
    const read = vi.fn(async () => statuses.shift() ?? { state: "ready", path: "/p", version: "1" })
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read }), { busy: 10, idle: 10_000 })
    const store = bridge.chatGptFor(HOST)
    const stop = store.subscribe(() => {})
    await waitFor(() => expect(store.getSnapshot().status).toMatchObject({ state: "ready" }))
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(3)
    const settled = read.mock.calls.length
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
    // Ready: the next read waits for the long interval.
    expect(read.mock.calls.length).toBe(settled)
    stop()
  })
  it("does not poll this computer: it has events", async () => {
    const read = vi.fn(async () => ({ state: "idle" }))
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read }), { busy: 10, idle: 10 })
    const stop = bridge.chatGptFor().subscribe(() => {})
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(read).toHaveBeenCalledOnce()
    stop()
  })
  it("shows an owner running an older Silo as unknown, without an error", async () => {
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "notConsented" }) }))
    const store = bridge.chatGptFor(HOST)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: { state: "unknown" }, loadError: null, error: null })
  })
})

describe("fixture for an unreadable remote status", () => {
  it("is readable once, then every read of a remote computer fails, while this computer stays readable", async () => {
    const fixture = createFixtureComputerUseBackend("ready", "ready", "ready-then-unreadable")
    await expect(fixture.chatGptStatus("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({ state: "ready" })
    await expect(fixture.chatGptStatus("11111111-1111-4111-8111-111111111111")).rejects.toThrow("connection")
    await expect(fixture.chatGptStatus()).resolves.toMatchObject({ state: "ready" })
  })
})

describe("ChatGPT status ordering", () => {
  it("reads only after the listener is registered", async () => {
    const registration = deferred<() => void>()
    const read = vi.fn(async () => ({ state: "idle" }))
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read, listenStatus: () => registration.promise }))
    bridge.chatGptFor().subscribe(() => {})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(read).not.toHaveBeenCalled()
    registration.resolve(() => {})
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
  })
  it("drops a read superseded by an event, so a late older status cannot replace it", async () => {
    const read = deferred<unknown>()
    let emit!: (payload: unknown) => void
    const bridge = createComputerUseBridge(backend({ chatGptStatus: () => read.promise, listenStatus: async handler => { emit = handler; return () => {} } }))
    const store = bridge.chatGptFor()
    const stop = store.subscribe(() => {})
    await waitFor(() => expect(emit).toBeDefined())
    await new Promise(resolve => setTimeout(resolve, 0))
    act(() => emit({ state: "ready", path: "/p", version: "1.2" }))
    expect(store.getSnapshot().status).toMatchObject({ state: "ready", version: "1.2" })
    await act(async () => { read.resolve({ state: "idle" }) })
    expect(store.getSnapshot().status).toMatchObject({ state: "ready", version: "1.2" })
    stop()
  })
  it("lets the latest of overlapping reads win", async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const reads = [first, second]
    const bridge = createComputerUseBridge(backend({ chatGptStatus: () => reads.shift()!.promise }))
    const store = bridge.chatGptFor()
    const a = store.refresh()
    const b = store.refresh()
    second.resolve({ state: "idle" })
    await b
    first.resolve({ state: "failed", reason: "x", retryable: true })
    await a
    expect(store.getSnapshot().status).toEqual({ state: "idle" })
  })
  it("reconciles with a read after Retry", async () => {
    const statuses: unknown[] = [{ state: "failed", reason: "Offline.", retryable: true }, { state: "downloading", receivedBytes: 1, totalBytes: 2 }]
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => statuses.shift(), retry: async () => {} }))
    const store = bridge.chatGptFor()
    await store.refresh()
    expect(store.getSnapshot().status).toMatchObject({ state: "failed" })
    await store.retry()
    expect(store.getSnapshot().status).toMatchObject({ state: "downloading" })
  })
  it("does not leak listeners when subscriptions change quickly", async () => {
    const pending: Array<ReturnType<typeof deferred<() => void>>> = []
    const disposed: number[] = []
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "idle" }), listenStatus: () => { const d = deferred<() => void>(); pending.push(d); return d.promise } }))
    const store = bridge.chatGptFor()
    for (let index = 0; index < 4; index += 1) store.subscribe(() => {})()
    const last = store.subscribe(() => {})
    expect(pending).toHaveLength(5)
    // Registrations resolve out of order, after all but the last subscription ended.
    for (const [index, d] of [...pending.entries()].reverse()) d.resolve(() => { disposed.push(index) })
    await waitFor(() => expect(disposed.slice().sort()).toEqual([0, 1, 2, 3]))
    last()
    await waitFor(() => expect(disposed.slice().sort()).toEqual([0, 1, 2, 3, 4]))
  })
})

describe("ChatGPT app errors", () => {
  it("shows a rejected Retry and keeps it until dismissed", async () => {
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "failed", reason: "Offline.", retryable: true }), retry: async () => { throw new Error("Silo could not reach the other computer.") } }))
    const store = bridge.chatGptFor(HOST)
    await store.refresh()
    await store.retry()
    expect(store.getSnapshot().error).toBe("Silo could not reach the other computer.")
    store.dismissError()
    expect(store.getSnapshot().error).toBeNull()
  })
  it("keeps a failed first status read for this computer, and recovers with the next", async () => {
    const reads = [() => Promise.reject(new Error("Silo could not read the status.")), () => Promise.resolve({ state: "idle" })]
    const bridge = createComputerUseBridge(backend({ chatGptStatus: () => reads.shift()!() }))
    render(<ChatGptAppStatusView store={bridge.chatGptFor()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Silo could not read the status.")
    await act(async () => { await bridge.chatGptFor().refresh() })
    expect(await screen.findByText("ChatGPT for Linux will download shortly.")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("computer use section reads and errors", () => {
  const section = (b: ComputerUseBackend, pollMs = 60_000) => render(wrap(b, <ComputerUseSection workspace="office/vm-1" pollMs={pollMs} />))
  it("never runs two reads at once, so a slow older read cannot overwrite a newer one", async () => {
    const slow = deferred<unknown>()
    let active = 0
    let peak = 0
    let calls = 0
    section(backend({ readDesktopState: async () => {
      calls += 1
      active += 1
      peak = Math.max(peak, active)
      try { return calls === 1 ? await slow.promise : fixtureDesktopState("failed") } finally { active -= 1 }
    } }), 10)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
    expect(calls).toBe(1)
    await act(async () => { slow.resolve(fixtureDesktopState("ready")) })
    // Later reads return "failed" every 10 ms, so a transient "Ready" may be
    // replaced before a slow runner observes it; what matters is that reads
    // continue and never overlap.
    await waitFor(() => expect(calls).toBeGreaterThan(1))
    expect(peak).toBe(1)
  })
  it("shows a failed first read instead of nothing, and recovers with Try again", async () => {
    const reads = [() => Promise.reject(new Error("office-mac is offline")), () => Promise.resolve(fixtureDesktopState("ready"))]
    section(backend({ readDesktopState: () => reads.shift()!() }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("office-mac is offline")
    expect(screen.getByRole("region", { name: "Computer use" })).toBeVisible()
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByText("Ready")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("keeps a failed change visible while polling succeeds, until dismissed", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("ready"), setApproval: async () => { throw new Error("office-mac is offline") } }), 20)
    await userEvent.setup().click(await screen.findByRole("switch", { name: /Allow without asking/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("office-mac is offline")
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
    expect(screen.getByRole("alert")).toHaveTextContent("office-mac is offline")
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss error" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("keeps the panel and reports a poll that fails after a good read", async () => {
    const reads: Array<Promise<unknown>> = [Promise.resolve(fixtureDesktopState("ready"))]
    section(backend({ readDesktopState: () => reads.shift() ?? Promise.reject(new Error("Connection lost")) }), 20)
    expect(await screen.findByText("Ready")).toBeVisible()
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost")
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeVisible()
  })
  it("reads the download progress of the computer that owns the sandbox", async () => {
    const status = vi.fn(async (_computer?: string) => ({ state: "downloading", receivedBytes: 100_000_000, totalBytes: 200_000_000 }))
    render(wrap(backend({ readDesktopState: async () => fixtureDesktopState("preparing"), chatGptStatus: status }), <ComputerUseSection workspace={remoteVm} pollMs={60_000} />))
    expect(await screen.findByText(/100 MB of 200 MB/)).toBeVisible()
    expect(status).toHaveBeenCalledWith(HOST)
  })
})

describe("unreadable approval policy", () => {
  it("is unknown, not ask, when missing or malformed", () => {
    const desktop = { installed: true, autoStart: true, state: "running" }
    expect(parseLinuxDesktopState({ ...desktop, computerUse: { state: "ready" } }).computerUse?.approval).toBe("unknown")
    expect(parseLinuxDesktopState({ ...desktop, computerUse: { state: "ready", approval: 3 } }).computerUse?.approval).toBe("unknown")
    expect(parseLinuxDesktopState({ ...desktop, computerUse: { state: "ready", approval: "auto" } }).computerUse?.approval).toBe("auto")
  })
  it("disables the switch with a diagnostic while keeping version details readable", () => {
    render(<ComputerUsePanel computerUse={{ ...ready, approval: "unknown" }} running busy={false} error={null} onApproval={vi.fn()} onSetup={vi.fn()} />)
    const toggle = screen.getByRole("switch", { name: /Allow without asking/ })
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole("note")).toHaveTextContent("could not read this sandbox's approval setting")
    expect(screen.getByText("26.928.31416")).toBeInTheDocument()
  })
})

describe("approval copy", () => {
  it("does not claim every agent asks or that accounts are out of reach", () => {
    render(<ComputerUsePanel computerUse={ready} running busy={false} error={null} onApproval={vi.fn()} onSetup={vi.fn()} />)
    const text = screen.getByRole("region", { name: "Computer use" }).textContent ?? ""
    expect(text).toMatch(/Claude Code and Codex/)
    expect(text).toMatch(/signed in to inside this sandbox/)
    expect(text).not.toMatch(/stay out of reach/)
  })
})
