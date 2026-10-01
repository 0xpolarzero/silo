import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "@/features/sandboxes/components/machine-list"
import { computerUseFixtureNames, createFixtureComputerUseBackend, fixtureComputerUse, fixtureDesktopState } from "@/fixtures/computer-use"
import { ComputerUseProvider, createComputerUseBridge, type ComputerUseBackend } from "./computer-use-bridge"
import { ChatGptAppFlow, ComputerUsePanel, ComputerUseSection, OPENAI_TERMS_URL, computerUseLabel } from "./computer-use-panel"
import { LinuxDesktopViewer } from "./linux-desktop-viewer"
import { chatGptAppStatusSchema, parseLinuxDesktopState, type ComputerUseState, type LinuxDesktopState } from "./linux-desktop-state"

const ready = fixtureComputerUse("ready")

function backend(overrides: Partial<ComputerUseBackend> = {}): ComputerUseBackend {
  const base = createFixtureComputerUseBackend("ready", "notConsented")
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
    expect(parsed.computerUse).toMatchObject({ state: "unavailable", compatibility: "unknown", approval: "ask", agents: null, appVersion: null })
    expect(parseLinuxDesktopState({ ...desktop, computerUse: "broken" }).computerUse).toBeNull()
  })
  it.each([
    [{ state: "notConsented" }], [{ state: "idle" }], [{ state: "downloading", receivedBytes: 1, totalBytes: 2 }], [{ state: "verifying" }],
    [{ state: "extracting" }], [{ state: "ready", path: "/p", version: "1" }], [{ state: "failed", reason: "x", retryable: true }],
  ])("parses ChatGPT app status %j", status => { expect(chatGptAppStatusSchema.parse(status)).toMatchObject(status) })
  it("tolerates detail fields but rejects an unknown status", () => {
    expect(chatGptAppStatusSchema.parse({ state: "downloading", receivedBytes: "many" })).toMatchObject({ receivedBytes: 0 })
    expect(chatGptAppStatusSchema.safeParse({ state: "mystery" }).success).toBe(false)
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
    expect(screen.getByRole("region", { name: "Computer use" })).toHaveTextContent(computerUseLabel(state.state))
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
    expect(screen.getByText(/will not ask for approval/)).toBeVisible()
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

describe("one-time ChatGPT notice", () => {
  it("shows nothing without a store", () => {
    render(wrap(backend(), <ChatGptAppFlow store={undefined} />))
    expect(screen.queryByRole("group")).not.toBeInTheDocument()
  })
  it("accepts, records consent, then prepares", async () => {
    const calls: string[] = []
    const b = backend({ acceptNotice: async () => { calls.push("accept") }, prepare: async () => { calls.push("prepare") } })
    const bridge = createComputerUseBridge(b)
    render(<ChatGptAppFlow store={bridge.chatGpt} />)
    const notice = await screen.findByRole("group", { name: "Download ChatGPT for Linux?" })
    expect(notice).toHaveTextContent("official ChatGPT app for Linux from OpenAI")
    expect(notice).toHaveTextContent("450 MB")
    expect(notice).toHaveTextContent("1.5 GB")
    expect(within(notice).getByRole("link", { name: "OpenAI terms of use" })).toHaveAttribute("href", OPENAI_TERMS_URL)
    await userEvent.setup().click(within(notice).getByRole("button", { name: "Accept" }))
    await waitFor(() => expect(calls).toEqual(["accept", "prepare"]))
  })
  it("does not prepare when recording consent fails", async () => {
    const prepare = vi.fn()
    const bridge = createComputerUseBridge(backend({ acceptNotice: async () => { throw new Error("Disk is full") }, prepare }))
    render(<ChatGptAppFlow store={bridge.chatGpt} />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Accept" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk is full")
    expect(prepare).not.toHaveBeenCalled()
  })
  it("Not now dismisses the notice without calling the backend", async () => {
    const accept = vi.fn()
    const bridge = createComputerUseBridge(backend({ acceptNotice: accept }))
    render(<ChatGptAppFlow store={bridge.chatGpt} />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Not now" }))
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument()
    expect(accept).not.toHaveBeenCalled()
  })
  it("follows chatgpt-app-status events through to ready, then failure with retry", async () => {
    let emit!: (status: unknown) => void
    const prepare = vi.fn()
    const bridge = createComputerUseBridge(backend({ prepare, chatGptStatus: async () => ({ state: "idle" }), listenStatus: async handler => { emit = handler; return () => {} } }))
    render(<ChatGptAppFlow store={bridge.chatGpt} showReady />)
    await screen.findByText("ChatGPT for Linux has not been downloaded yet.")
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
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    expect(prepare).toHaveBeenCalledOnce()
    act(() => emit({ state: "ready", path: "/p", version: "26.928.31416" }))
    expect(screen.getByRole("status")).toHaveTextContent("ChatGPT for Linux is ready (26.928.31416)")
  })
  it("offers no retry for a failure that cannot be retried and ignores unknown statuses", async () => {
    let emit!: (status: unknown) => void
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "failed", reason: "Checksum mismatch.", retryable: false }), listenStatus: async handler => { emit = handler; return () => {} } }))
    render(<ChatGptAppFlow store={bridge.chatGpt} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Checksum mismatch.")
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
    act(() => emit({ state: "from-the-future" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Checksum mismatch.")
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
  it("shows the consent notice when the app is waiting for approval", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("needs-consent") }))
    expect(await screen.findByRole("button", { name: "Accept" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Not now" })).not.toBeInTheDocument()
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
  it("shows the notice instead of the desktop checkbox when creating a sandbox, and Not now does not block saving", async () => {
    const user = userEvent.setup()
    editor(machine, false, true)
    expect(screen.queryByRole("checkbox", { name: "Linux desktop" })).not.toBeInTheDocument()
    await screen.findByRole("group", { name: "Download ChatGPT for Linux?" })
    await user.click(screen.getByRole("button", { name: "Not now" }))
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })
  it("keeps the desktop checkbox without computer use support", () => {
    editor(machine, false, false)
    expect(screen.getByRole("checkbox", { name: "Linux desktop" })).toBeVisible()
  })
})
