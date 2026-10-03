import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { setupFakeTimerUser } from "@/test/fake-timer-user"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionComputerDefaults } from "@/features/onboarding/model/computer-configuration"
import { ComputerConfigurationList } from "@/features/computers/components/computer-configuration-list"
import { computerUseFixtureNames, createFixtureComputerUseBackend, fixtureChatGptStatus, fixtureComputerUse, fixtureDesktopState } from "@/fixtures/computer-use"
import { deviceOfComputer, createComputerUseBridge, type ComputerUseBackend } from "./computer-use-bridge"
import { ComputerUseProvider } from "./computer-use-provider"
import { CHATGPT_DOWNLOAD_NOTE, ChatGptAppProgress, ChatGptAppStatusView, ComputerUsePanel, ComputerUseSection } from "./computer-use-panel"
import { chatGptStatusText } from "./computer-use-labels"
import { ComputerUseApprovalSwitch, useComputerUseApproval, type ComputerUseApprovalController } from "./computer-use-approval"
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
  it("parses the computerUse object of a v4 computer", () => {
    const parsed = parseLinuxDesktopState({ ...desktop, computerUse: { ...ready, agents: ["Codex"] } })
    expect(parsed.computerUse).toMatchObject({ state: "ready", approval: "ask", compatibility: "tested", appVersion: "26.928.31416", agents: ["Codex"] })
  })
  it("leaves older computers without computerUse", () => {
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

function controller(computerUse: ComputerUseState | null | undefined, extra: Partial<ComputerUseApprovalController> = {}): ComputerUseApprovalController {
  return {
    state: null, computerUse, running: true, busy: false, error: null, loadError: null,
    setApproval: vi.fn(), setup: vi.fn(), refresh: vi.fn(), dismissError: vi.fn(), ...extra,
  }
}
const renderPanel = (computerUse: ComputerUseState, extra: Partial<ComputerUseApprovalController> = {}, chatGpt?: Parameters<typeof ComputerUsePanel>[0]["chatGpt"]) => {
  const approval = controller(computerUse, extra)
  render(<ComputerUsePanel approval={approval} chatGpt={chatGpt} />)
  return approval
}

describe("computer use panel", () => {
  it.each(["preparing", "installing", "ready", "untested", "auto"] as const)("shows only the approval switch and one hint while %s", name => {
    const { container } = render(<ComputerUsePanel approval={controller(fixtureComputerUse(name))} />)
    expect(screen.getByRole("switch", { name: "Allow without asking" })).toBeVisible()
    expect(screen.getByText(/use this computer's desktop without asking first/)).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("note")).not.toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent(/Details|Set up computer use|Installing|Ready|Preparing|26\.928/)
  })
  it("keeps the switch while the computer's computer use is still unavailable", () => {
    renderPanel(fixtureComputerUse("unavailable"))
    expect(screen.getByRole("switch", { name: "Allow without asking" })).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("binds the switch to the approval mode", async () => {
    const user = userEvent.setup()
    const approval = renderPanel({ ...ready, approval: "auto" })
    const toggle = screen.getByRole("switch", { name: "Allow without asking" })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(approval.setApproval).toHaveBeenCalledWith("ask")
  })
  it("keeps the switch usable while the computer is stopped", async () => {
    const approval = renderPanel(ready, { running: false })
    await userEvent.setup().click(screen.getByRole("switch", { name: "Allow without asking" }))
    expect(approval.setApproval).toHaveBeenCalledWith("auto")
  })
  it("offers Try again for a failed setup, running setup only while the computer runs", async () => {
    const approval = renderPanel(fixtureComputerUse("failed"))
    expect(screen.getByRole("alert")).toHaveTextContent("setup failed")
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(approval.setup).toHaveBeenCalledOnce()
  })
  it("explains instead of running setup when the computer is stopped", () => {
    renderPanel(fixtureComputerUse("failed"), { running: false })
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute("title", "Start the computer to try again.")
  })
  it("keeps the backend reason of a failure in a tooltip", () => {
    renderPanel(fixtureComputerUse("app-failed"), {}, { retry: vi.fn(), busy: false })
    expect(screen.getByText("ChatGPT download failed.")).toHaveAttribute("title", fixtureComputerUse("app-failed").reason)
  })
  it("retries a failed ChatGPT download without offering setup", async () => {
    const retry = vi.fn()
    renderPanel(fixtureComputerUse("app-failed"), {}, { retry, busy: false })
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledOnce()
  })
  it("disables Retry while a retry is under way and shows a rejected one", () => {
    renderPanel(fixtureComputerUse("app-failed"), {}, { retry: vi.fn(), busy: true, error: "The device is offline." })
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled()
    expect(screen.getByText("The device is offline.")).toBeVisible()
  })
  it("shows errors from the owning device as they came, and reads that fail with Try again", async () => {
    const approval = renderPanel(ready, { error: "Device disconnected: office-mac", loadError: "Connection lost" })
    expect(screen.getAllByRole("alert").map(alert => alert.textContent)).toEqual([expect.stringContaining("Device disconnected: office-mac"), expect.stringContaining("Connection lost")])
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(approval.refresh).toHaveBeenCalledOnce()
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss error" }))
    expect(approval.dismissError).toHaveBeenCalledOnce()
  })
})

describe("approval switch for other surfaces", () => {
  it("renders nothing until the computer's computer use is known", () => {
    const { container } = render(<ComputerUseApprovalSwitch approval={controller(null)} />)
    expect(container).toBeEmptyDOMElement()
  })
  it("embeds on its own with a hook", async () => {
    const setApproval = vi.fn(async (_computer: string, mode: "ask" | "auto") => ({ ...fixtureDesktopState("ready"), computerUse: { ...ready, approval: mode, appliedApproval: mode } }))
    function Toast() { return <ComputerUseApprovalSwitch approval={useComputerUseApproval("office/vm-1", 60_000)} /> }
    render(wrap(backend({ readDesktopState: async () => fixtureDesktopState("ready"), setApproval }), <Toast />))
    await userEvent.setup().click(await screen.findByRole("switch", { name: "Allow without asking" }))
    await waitFor(() => expect(screen.getByRole("switch", { name: "Allow without asking" })).toBeChecked())
    expect(setApproval).toHaveBeenCalledWith("office/vm-1", "auto")
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
    expect(CHATGPT_DOWNLOAD_NOTE).toBe("Silo downloads ChatGPT for Linux from OpenAI so agents in your computers can use the Linux desktop.")
  })
})

describe("computer use section", () => {
  function section(b: ComputerUseBackend) {
    render(wrap(b, <ComputerUseSection computer="office/vm-1" pollMs={60_000} />))
  }
  it("sets the approval mode through the owning device's command and shows the result", async () => {
    const setApproval = vi.fn(async (_computer: string, mode: "ask" | "auto") => ({ ...fixtureDesktopState("ready"), computerUse: { ...ready, approval: mode } }))
    section(backend({ readDesktopState: async () => fixtureDesktopState("ready"), setApproval }))
    const toggle = await screen.findByRole("switch", { name: /Allow without asking/ })
    expect(toggle).not.toBeChecked()
    await userEvent.setup().click(toggle)
    await waitFor(() => expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeChecked())
    expect(setApproval).toHaveBeenCalledWith("office/vm-1", "auto")
  })
  it("reports a failed approval change and shows the state read afterwards", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("ready"), setApproval: async () => { throw new Error("office-mac is offline") } }))
    await userEvent.setup().click(await screen.findByRole("switch", { name: /Allow without asking/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("office-mac is offline")
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).not.toBeChecked()
  })
  it("runs setup from Try again after a failed setup and returns to the plain switch", async () => {
    const setup = vi.fn(async () => fixtureDesktopState("ready"))
    section(backend({ readDesktopState: async () => fixtureDesktopState("failed"), setup }))
    await screen.findByText(/setup failed/)
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(setup).toHaveBeenCalledWith("office/vm-1")
  })
  it("shows no download progress while the app is preparing", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("preparing"), chatGptStatus: async () => ({ state: "downloading", receivedBytes: 187_000_000, totalBytes: 453_000_000 }) }))
    await screen.findByRole("switch", { name: "Allow without asking" })
    expect(screen.queryByText(/187 MB/)).not.toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
  it("shows a rejected setup", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("failed"), setup: async () => { throw new Error("The computer stopped.") } }))
    await screen.findByText(/setup failed/)
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByText("The computer stopped.")).toBeVisible()
  })
  it("retries a failed ChatGPT download without offering setup", async () => {
    const retry = vi.fn(async (_device?: string) => ({}))
    section(backend({ readDesktopState: async () => fixtureDesktopState("app-failed"), chatGptStatus: async () => fixtureChatGptStatus("failed-final"), retry }))
    expect(await screen.findByText("ChatGPT download failed.")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
  })
  it("keeps a guest setup failure on Try again, without a download Retry", async () => {
    section(backend({ readDesktopState: async () => fixtureDesktopState("failed"), chatGptStatus: async () => fixtureChatGptStatus("ready") }))
    expect(await screen.findByText(/setup failed/)).toBeVisible()
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })
  it("renders nothing for a pre-v4 computer", async () => {
    const read = vi.fn(async () => fixtureDesktopState("pre-v4"))
    section(backend({ readDesktopState: read }))
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(screen.queryByRole("region", { name: "Computer use" })).not.toBeInTheDocument()
  })
  it("renders nothing without a bridge", () => {
    render(<ComputerUseSection computer="dev" />)
    expect(screen.queryByRole("region", { name: "Computer use" })).not.toBeInTheDocument()
  })
})

describe("v3 and v4 desktop viewer", () => {
  function viewer(state: LinuxDesktopState) {
    const onAction = vi.fn()
    render(<LinuxDesktopViewer name="dev" state={state} busy={false} error={null} onAction={onAction} onRetry={vi.fn()} onFullscreen={vi.fn()} />)
    return onAction
  }
  it("offers legacy LCU setup only for older computers", async () => {
    const onAction = viewer(fixtureDesktopState("pre-v4"))
    await userEvent.setup().click(screen.getByRole("button", { name: "Set up LCU" }))
    expect(onAction).toHaveBeenCalledWith("setup-lcu")
  })
  it("shows nothing about computer use for a healthy v4 computer", () => {
    viewer(fixtureDesktopState("ready"))
    expect(screen.queryByText(/Computer use/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Set up/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Set up LCU" })).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("says a ChatGPT download failed without offering setup", async () => {
    const onAction = viewer(fixtureDesktopState("app-failed"))
    expect(screen.getByRole("alert")).toHaveTextContent("ChatGPT download failed. Retry from the computer's page.")
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })
  it("offers Try again for a failed setup of the computer itself", async () => {
    const onAction = viewer(fixtureDesktopState("failed"))
    expect(screen.getByRole("alert")).toHaveTextContent("Computer use setup failed")
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(onAction).toHaveBeenCalledWith("setup-computer-use")
  })
  it("shows nothing while computer use is installing", () => {
    viewer(fixtureDesktopState("installing"))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Set up|Try again/ })).not.toBeInTheDocument()
  })
  it("does not send a v4 computer to Add Linux desktop", () => {
    viewer({ ...fixtureDesktopState("ready"), state: "uninstalled", installed: false })
    expect(screen.queryByText(/Add Linux desktop/)).not.toBeInTheDocument()
    expect(screen.getByText("Desktop unavailable")).toBeVisible()
  })
  it("still points an older computer to Add Linux desktop", () => {
    viewer({ installed: false, autoStart: false, state: "uninstalled" })
    expect(screen.getByText(/Add Linux desktop/)).toBeVisible()
  })
})

describe("computer settings for v3 and v4", () => {
  const configuration = productionComputerDefaults[0]
  function editor(draft: typeof configuration, created: boolean, provider: boolean) {
    const list = <TooltipProvider><ComputerConfigurationList configurations={created ? [draft] : []} onConfigurationsChange={vi.fn()}
      isComputerCreated={() => created} isComputerRunning={() => created}
      initialEditorDraft={{ draft, originalID: created ? draft.id : undefined, insertAt: 0 }} /></TooltipProvider>
    render(provider ? wrap(backend(), list) : list)
  }
  it("shows no desktop controls or note for a built-in computer", () => {
    editor({ ...configuration, desktop: { startWithComputer: true, builtIn: true } }, true, true)
    expect(screen.queryByRole("switch", { name: "Start desktop with computer" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add Linux desktop" })).not.toBeInTheDocument()
    expect(screen.queryByText(/Built in/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Linux desktop and computer use/)).not.toBeInTheDocument()
  })
  it("keeps the startup switch for a computer created before v4", () => {
    editor({ ...configuration, desktop: { startWithComputer: true } }, true, true)
    expect(screen.getByRole("switch", { name: "Start desktop with computer" })).toBeVisible()
  })
  it("keeps Add Linux desktop for an older computer without a desktop", () => {
    editor(configuration, true, true)
    expect(screen.getByRole("button", { name: "Add Linux desktop" })).toBeVisible()
  })
  it("shows no download notice or consent when creating a computer, and saving is never blocked", async () => {
    editor(configuration, false, true)
    expect(screen.queryByRole("checkbox", { name: "Linux desktop" })).not.toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Download ChatGPT for Linux?" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Accept|Not now/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled()
  })
  it("keeps the desktop checkbox without computer use support", () => {
    editor(configuration, false, false)
    expect(screen.getByRole("checkbox", { name: "Linux desktop" })).toBeVisible()
  })
})

describe("creating a computer on the selected device", () => {
  const configuration = productionComputerDefaults[0]
  const devices = [{ id: "11111111-1111-4111-8111-111111111111", name: "Linux box", connected: true }]
  function creating(status: unknown, draft: typeof configuration = configuration, onConfigurationsChange = vi.fn()) {
    const bridgeBackend = backend({ chatGptStatus: async device => device ? status : { state: "ready" } })
    render(wrap(bridgeBackend, <TooltipProvider><ComputerConfigurationList configurations={[]} devices={devices} getDeviceId={() => undefined} onConfigurationsChange={onConfigurationsChange}
      isComputerCreated={() => false} isComputerRunning={() => false}
      initialEditorDraft={{ draft, insertAt: 0 }} /></TooltipProvider>))
    return onConfigurationsChange
  }
  const choose = (user: ReturnType<typeof userEvent.setup>) => user.selectOptions(screen.getByRole("combobox", { name: "Run on" }), devices[0]!.id)

  it("offers the optional desktop and says to update an older remote owner", async () => {
    creating({ state: "unknown" })
    const user = userEvent.setup()
    expect(screen.queryByRole("checkbox", { name: "Linux desktop" })).not.toBeInTheDocument()
    await choose(user)
    expect(await screen.findByText(/Update Silo on Linux box for built-in computer use/)).toBeVisible()
    expect(screen.getByRole("checkbox", { name: "Linux desktop" })).toBeVisible()
  })
  it("shows no desktop controls for a remote owner that supports the built-in desktop", async () => {
    creating({ state: "ready" })
    const user = userEvent.setup()
    await choose(user)
    await waitFor(() => expect(screen.queryByText(/Checking Linux box/)).not.toBeInTheDocument())
    expect(screen.queryByText(/Built in/)).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "Linux desktop" })).not.toBeInTheDocument()
  })
  it("starts the desktop of a new built-in computer even when duplicated settings chose to start it by hand", async () => {
    const onConfigurationsChange = creating({ state: "ready" }, { ...configuration, desktop: { startWithComputer: false } })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(onConfigurationsChange).toHaveBeenCalled())
    expect(onConfigurationsChange.mock.lastCall?.[0]).toEqual([expect.objectContaining({ desktop: { startWithComputer: true } })])
  })
  it("keeps a manual desktop start for a computer created before the built-in desktop", () => {
    const draft = { ...configuration, desktop: { startWithComputer: false } }
    render(wrap(backend(), <TooltipProvider><ComputerConfigurationList configurations={[draft]} onConfigurationsChange={vi.fn()}
      isComputerCreated={() => true} isComputerRunning={() => false}
      initialEditorDraft={{ draft, originalID: draft.id, insertAt: 0 }} /></TooltipProvider>))
    expect(screen.getByRole("switch", { name: "Start desktop with computer" })).not.toBeChecked()
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
const remoteComputer = `silo-remote:${HOST}:${VM}`

describe("ChatGPT app store per device", () => {
  it("addresses a device by its device id, never a placeholder computer, and keeps one store per device", async () => {
    const calls: Array<[string, string | undefined]> = []
    const bridge = createComputerUseBridge(backend({
      chatGptStatus: async device => { calls.push(["status", device]); return { state: "failed", reason: "Offline.", retryable: true } },
      retry: async device => { calls.push(["retry", device]) },
    }))
    expect(bridge.chatGptFor()).toBe(bridge.chatGptFor())
    expect(bridge.chatGptFor(HOST)).toBe(bridge.chatGptFor(deviceOfComputer(remoteComputer)))
    expect(bridge.chatGptFor(HOST)).not.toBe(bridge.chatGptFor())
    expect(bridge.chatGptFor(HOST)).not.toBe(bridge.chatGptFor(OTHER))
    await bridge.chatGptFor(HOST).retry()
    await bridge.chatGptFor().refresh()
    expect(calls.filter(([name]) => name === "retry")).toEqual([["retry", HOST]])
    expect(calls.at(-1)).toEqual(["status", undefined])
    expect(JSON.stringify(calls)).not.toContain("silo-remote")
  })
  it("finds the owning device of a computer", () => {
    expect(deviceOfComputer(remoteComputer)).toBe(HOST)
    expect(deviceOfComputer("dev")).toBeUndefined()
    expect(deviceOfComputer(undefined)).toBeUndefined()
  })
  it("applies a status event only to this device", async () => {
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
  it("reads a remote device's status again on a schedule, faster while it works", async () => {
    vi.useFakeTimers()
    const statuses: unknown[] = [{ state: "downloading", receivedBytes: 1, totalBytes: 10 }, { state: "downloading", receivedBytes: 5, totalBytes: 10 }, { state: "ready", path: "/p", version: "1" }]
    const read = vi.fn(async () => statuses.shift() ?? { state: "ready", path: "/p", version: "1" })
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read }), { busy: 10, idle: 10_000 })
    const store = bridge.chatGptFor(HOST)
    const stop = store.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledOnce()
      expect(store.getSnapshot().status).toMatchObject({ state: "downloading", receivedBytes: 1 })
      await vi.advanceTimersByTimeAsync(9)
      expect(read).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(read).toHaveBeenCalledTimes(2)
      expect(store.getSnapshot().status).toMatchObject({ state: "downloading", receivedBytes: 5 })
      await vi.advanceTimersByTimeAsync(10)
      expect(read).toHaveBeenCalledTimes(3)
      expect(store.getSnapshot().status).toMatchObject({ state: "ready" })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(read).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(read).toHaveBeenCalledTimes(4)
      stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(read).toHaveBeenCalledTimes(4)
    } finally { stop() }
  })
  it("does not poll this device: it has events", async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => ({ state: "idle" }))
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read }), { busy: 10, idle: 10 })
    const stop = bridge.chatGptFor().subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(60)
      expect(read).toHaveBeenCalledOnce()
    } finally { stop() }
  })
  it("shows an owner running an older Silo as unknown, without an error", async () => {
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "notConsented" }) }))
    const store = bridge.chatGptFor(HOST)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: { state: "unknown" }, loadError: null, error: null })
  })
})

describe("fixture for an unreadable remote status", () => {
  it("is readable once, then every read of a remote device fails, while this device stays readable", async () => {
    const fixture = createFixtureComputerUseBackend("ready", "ready", "ready-then-unreadable")
    await expect(fixture.chatGptStatus("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({ state: "ready" })
    await expect(fixture.chatGptStatus("11111111-1111-4111-8111-111111111111")).rejects.toThrow("connection")
    await expect(fixture.chatGptStatus()).resolves.toMatchObject({ state: "ready" })
  })
})

describe("local ChatGPT status subscription recovery", () => {
  it("recovers a failed registration and catches up without permanent polling", async () => {
    vi.useFakeTimers()
    let status: unknown = { state: "downloading", receivedBytes: 1, totalBytes: 10 }
    let emit!: (payload: unknown) => void
    const read = vi.fn(async () => status)
    const stopListening = vi.fn()
    const listen = vi.fn().mockRejectedValueOnce(new Error("Event bridge unavailable"))
      .mockImplementation(async handler => { emit = handler; return stopListening })
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read, listenStatus: listen }))
    const view = render(<ChatGptAppStatusView store={bridge.chatGptFor()} />)
    try {
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(screen.getByRole("status")).toHaveTextContent("Downloading")
      status = { state: "ready", path: "/p", version: "1" }
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(bridge.chatGptFor().getSnapshot().status).toMatchObject({ state: "ready" })
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(listen).toHaveBeenCalledTimes(2)
      expect(read).toHaveBeenCalledTimes(2)
      act(() => emit({ state: "verifying" }))
      expect(screen.getByRole("status")).toHaveTextContent("Verifying")
      view.unmount()
      expect(stopListening).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { view.unmount(); vi.useRealTimers() }
  })

  it("exposes a working Refresh after listener registration fails", async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValueOnce({ state: "downloading", receivedBytes: 1, totalBytes: 10 })
      .mockResolvedValue({ state: "ready", path: "/p", version: "1" })
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read, listenStatus: async () => { throw new Error("Event bridge unavailable") } }))
    const view = render(<ChatGptAppStatusView store={bridge.chatGptFor()} />)
    try {
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(screen.getByRole("alert")).toHaveTextContent("Event bridge unavailable")
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh status" })))
      expect(read).toHaveBeenCalledTimes(2)
      expect(bridge.chatGptFor().getSnapshot().status).toMatchObject({ state: "ready" })
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    } finally { view.unmount(); vi.useRealTimers() }
  })

  it("suspends failed subscription retries while hidden and cancels them on disposal", async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    const listen = vi.fn().mockRejectedValue(new Error("Event bridge unavailable"))
    const read = vi.fn().mockResolvedValue({ state: "idle" })
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read, listenStatus: listen }))
    const stop = bridge.chatGptFor().subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      visibility.mockReturnValue("hidden")
      document.dispatchEvent(new Event("visibilitychange"))
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(listen).toHaveBeenCalledOnce()
      visibility.mockReturnValue("visible")
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(0)
      expect(listen).toHaveBeenCalledTimes(2)
      stop()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(listen).toHaveBeenCalledTimes(2)
      expect(read).toHaveBeenCalledTimes(2)
    } finally { stop(); visibility.mockRestore(); vi.useRealTimers() }
  })
})

describe("ChatGPT status ordering", () => {
  it("reads only after the listener is registered", async () => {
    vi.useFakeTimers()
    const registration = deferred<() => void>()
    const read = vi.fn(async () => ({ state: "idle" }))
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read, listenStatus: () => registration.promise }))
    const stop = bridge.chatGptFor().subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(read).not.toHaveBeenCalled()
      registration.resolve(() => {})
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledOnce()
    } finally { stop() }
  })
  it("drops a read superseded by an event, so a late older status cannot replace it", async () => {
    vi.useFakeTimers()
    const pending = deferred<unknown>()
    const read = vi.fn(() => pending.promise)
    let emit!: (payload: unknown) => void
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read, listenStatus: async handler => { emit = handler; return () => {} } }))
    const store = bridge.chatGptFor()
    const stop = store.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledOnce()
      act(() => emit({ state: "ready", path: "/p", version: "1.2" }))
      expect(store.getSnapshot().status).toMatchObject({ state: "ready", version: "1.2" })
      await act(async () => { pending.resolve({ state: "idle" }) })
      expect(store.getSnapshot().status).toMatchObject({ state: "ready", version: "1.2" })
    } finally { stop() }
  })
  it("drops a read error superseded by a status event", async () => {
    const pending = deferred<unknown>()
    const read = vi.fn(() => pending.promise)
    let emit!: (payload: unknown) => void
    const bridge = createComputerUseBridge(backend({ chatGptStatus: read, listenStatus: async handler => { emit = handler; return () => {} } }))
    const store = bridge.chatGptFor()
    const stop = store.subscribe(() => {})
    try {
      await waitFor(() => expect(read).toHaveBeenCalledOnce())
      act(() => emit({ state: "ready", path: "/p", version: "1.2" }))
      await act(async () => { pending.reject(new Error("Status read failed")) })
      expect(store.getSnapshot()).toMatchObject({ status: { state: "ready", version: "1.2" }, loadError: null })
    } finally { stop() }
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
  it("keeps a rejected Retry visible when status cannot be read", async () => {
    const initial = deferred<unknown>()
    const read = vi.fn().mockImplementationOnce(() => initial.promise).mockRejectedValue(new Error("Status unavailable."))
    const store = createComputerUseBridge(backend({
      chatGptStatus: read,
      retry: async () => { throw new Error("Update Silo on that device to use computer use.") },
    })).chatGptFor(HOST)
    const view = render(<ChatGptAppStatusView store={store} retry fallbackReason="Download failed." />)
    try {
      await waitFor(() => expect(read).toHaveBeenCalledOnce())
      await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
      await waitFor(() => expect(store.getSnapshot().loadError).toBe("Status unavailable."))
      expect(screen.getAllByRole("alert").map(alert => alert.textContent).join(" ")).toContain("Update Silo on that device to use computer use.")
      await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss error" }))
      expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable.")
    } finally { view.unmount(); initial.resolve({ state: "idle" }) }
  })

  it.each(["ready", "unknown"] as const)("keeps a rejected Retry visible when the next status is %s", async state => {
    let attempted = false
    const retry = vi.fn(async () => {
      attempted = true
      throw new Error("Update Silo on that device to use computer use.")
    })
    const read = vi.fn(async () => attempted ? { state } : { state: "failed", reason: "Download failed.", retryable: false })
    const store = createComputerUseBridge(backend({ chatGptStatus: read, retry })).chatGptFor(HOST)
    await store.refresh()
    const view = render(<ChatGptAppStatusView store={store} retry />)
    try {
      await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
      await waitFor(() => expect(store.getSnapshot().status).toMatchObject({ state }))
      expect(screen.getByRole("alert")).toHaveTextContent("Update Silo on that device to use computer use.")
      expect(retry).toHaveBeenCalledOnce()
      await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss error" }))
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    } finally { view.unmount() }
  })

  it("reports a malformed status after a successful read and recovers on Refresh", async () => {
    const read = vi.fn().mockResolvedValueOnce({ state: "ready", version: "1" })
      .mockResolvedValueOnce(null).mockResolvedValue({ state: "idle" })
    const store = createComputerUseBridge(backend({ chatGptStatus: read })).chatGptFor(HOST)
    await store.refresh()
    const view = render(<ChatGptAppStatusView store={store} />)
    try {
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
      expect(store.getSnapshot().status).toMatchObject({ state: "ready", version: "1" })
      expect(screen.getByRole("alert")).toHaveTextContent("Silo could not read the ChatGPT for Linux status.")
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh status" })))
      expect(screen.getByRole("status")).toHaveTextContent("ChatGPT for Linux will download shortly.")
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    } finally { view.unmount() }
  })
  it("shows a rejected Retry and keeps it until dismissed", async () => {
    const bridge = createComputerUseBridge(backend({ chatGptStatus: async () => ({ state: "failed", reason: "Offline.", retryable: true }), retry: async () => { throw new Error("Silo could not reach the other device.") } }))
    const store = bridge.chatGptFor(HOST)
    await store.refresh()
    await store.retry()
    expect(store.getSnapshot().error).toBe("Silo could not reach the other device.")
    store.dismissError()
    expect(store.getSnapshot().error).toBeNull()
  })
  it("keeps a failed first status read for this device, and recovers with the next", async () => {
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
  const section = (b: ComputerUseBackend, pollMs = 60_000) => render(wrap(b, <ComputerUseSection computer="office/vm-1" pollMs={pollMs} />))
  it("never runs two reads at once, so a slow older read cannot overwrite a newer one", async () => {
    vi.useFakeTimers()
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
    await act(async () => { await vi.advanceTimersByTimeAsync(80) })
    expect(calls).toBe(1)
    await act(async () => { slow.resolve(fixtureDesktopState("ready")) })
    expect(screen.getByRole("switch", { name: "Allow without asking" })).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(calls).toBe(2)
    expect(screen.getByRole("alert")).toHaveTextContent("setup failed")
    expect(peak).toBe(1)
  })
  it("shows a failed first read instead of nothing, and recovers with Try again", async () => {
    const reads = [() => Promise.reject(new Error("office-mac is offline")), () => Promise.resolve(fixtureDesktopState("ready"))]
    section(backend({ readDesktopState: () => reads.shift()!() }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("office-mac is offline")
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByRole("switch", { name: "Allow without asking" })).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("keeps a failed change visible while polling succeeds, until dismissed", async () => {
    vi.useFakeTimers()
    const user = setupFakeTimerUser()
    const read = vi.fn(async () => fixtureDesktopState("ready"))
    section(backend({ readDesktopState: read, setApproval: async () => { throw new Error("office-mac is offline") } }), 20)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await user.click(screen.getByRole("switch", { name: /Allow without asking/ }))
    expect(screen.getByRole("alert")).toHaveTextContent("office-mac is offline")
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(read).toHaveBeenCalledTimes(8)
    expect(screen.getByRole("alert")).toHaveTextContent("office-mac is offline")
    await user.click(screen.getByRole("button", { name: "Dismiss error" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("keeps the panel and reports a poll that fails after a good read", async () => {
    vi.useFakeTimers()
    const reads: Array<Promise<unknown>> = [Promise.resolve(fixtureDesktopState("ready"))]
    section(backend({ readDesktopState: () => reads.shift() ?? Promise.reject(new Error("Connection lost")) }), 20)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole("switch", { name: "Allow without asking" })).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost")
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeVisible()
  })
  it("reads the ChatGPT status of the device that owns the computer, only for a failed download", async () => {
    const status = vi.fn(async (_device?: string) => ({ state: "downloading", receivedBytes: 100_000_000, totalBytes: 200_000_000 }))
    render(wrap(backend({ readDesktopState: async () => fixtureDesktopState("app-failed"), chatGptStatus: status }), <ComputerUseSection computer={remoteComputer} pollMs={60_000} />))
    await screen.findByRole("button", { name: "Retry" })
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
  it("disables the switch with a short warning", () => {
    renderPanel({ ...ready, approval: "unknown" })
    const toggle = screen.getByRole("switch", { name: /Allow without asking/ })
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole("note")).toHaveTextContent("could not read the approval setting. Agents may be running without asking.")
  })
})

describe("chosen and applied approval", () => {
  const desktop = { installed: true, autoStart: true, state: "running" }
  const parse = (computerUse: object) => parseLinuxDesktopState({ ...desktop, computerUse }).computerUse
  const render_ = (computerUse: ComputerUseState, extra: Partial<ComputerUseApprovalController> = {}) =>
    render(<ComputerUsePanel approval={controller(computerUse, extra)} />)
  it("parses appliedApproval and approvalApply tolerantly", () => {
    expect(parse({ state: "ready", approval: "ask" })?.appliedApproval).toBe("unknown")
    expect(parse({ state: "ready", approval: "ask", appliedApproval: 3 })?.appliedApproval).toBe("unknown")
    expect(parse({ state: "ready", approval: "ask", appliedApproval: "auto" })).toMatchObject({ approval: "ask", appliedApproval: "auto" })
    // An older Silo does not report how applying stands; absent or malformed status is unknown.
    expect(parse({ state: "ready", approval: "ask" })?.approvalApply).toBe("unknown")
    expect(parse({ state: "ready", approval: "ask", approvalApply: "sometime" })?.approvalApply).toBe("unknown")
    for (const value of ["applied", "pending", "failed", "partial"]) expect(parse({ state: "ready", approval: "ask", approvalApply: value, approvalApplyReason: "why" })).toMatchObject({ approvalApply: value, approvalApplyReason: "why" })
    expect(parse({ state: "ready", approvalApplyReason: 4 })?.approvalApplyReason).toBeNull()
  })
  it("shows the chosen mode, says Applying… while it is pending and warns that agents may still act without asking", () => {
    render_(fixtureComputerUse("approval-pending"))
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).not.toBeChecked()
    expect(screen.getByRole("status")).toHaveTextContent("Applying…")
    expect(screen.getByRole("note")).toHaveTextContent("Agents may still act without asking until this is applied.")
  })
  it("says agents still ask while a switch to auto is pending", () => {
    render_({ ...ready, approval: "auto", appliedApproval: "ask", approvalApply: "pending" })
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeChecked()
    expect(screen.getByRole("status")).toHaveTextContent("Applying…")
    expect(screen.getByRole("note")).toHaveTextContent("Agents may still ask first until this is applied.")
    expect(screen.queryByText(/still act without asking/)).toBeNull()
  })
  it("does not say Applying… for a stopped computer, and keeps the warning until the change is applied at start", () => {
    render_(fixtureComputerUse("approval-pending"), { running: false })
    expect(screen.queryByText("Applying…")).toBeNull()
    expect(screen.getByRole("note")).toHaveTextContent("may still act without asking until this is applied")
    // A computer that never applied anything has nothing to wait for.
    const { unmount } = render_({ ...ready, appliedApproval: "unknown", approvalApply: "pending" }, { running: false })
    expect(screen.getAllByRole("note")).toHaveLength(1)
    unmount()
  })
  it("reports a failed apply briefly, keeps its reason in a tooltip and keeps the choice", () => {
    render_(fixtureComputerUse("approval-failed"))
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).not.toBeChecked()
    const note = screen.getByRole("note")
    expect(note).toHaveTextContent("Not applied to every agent. Some may still act without asking.")
    expect(within(note).getByText(/Not applied/)).toHaveAttribute("title", expect.stringContaining("Applying took too long. Silo tries again when the computer starts."))
    expect(screen.queryByText("Applying…")).toBeNull()
  })
  it("reports a partial apply and warns that some agents may still act without asking", () => {
    render_(fixtureComputerUse("approval-partial"))
    const note = screen.getByRole("note")
    expect(note).toHaveTextContent("Some may still act without asking.")
    expect(within(note).getByText(/Not applied/)).toHaveAttribute("title", expect.stringContaining("Some agents could not be configured"))
    // Partial is a warning whatever the previous mode was.
    const { unmount } = render_({ ...ready, appliedApproval: "unknown", approvalApply: "partial" })
    expect(screen.getAllByRole("note").at(-1)).toHaveTextContent("may still act without asking")
    unmount()
  })
  it("warns after a failure to apply ask when nothing says ask is in place, and not when it is", () => {
    const { unmount } = render_({ ...ready, appliedApproval: "unknown", approvalApply: "failed", approvalApplyReason: "Silo could not reach the computer to apply it." })
    expect(screen.getByRole("note")).toHaveTextContent("may still act without asking")
    unmount()
    render_({ ...ready, appliedApproval: "ask", approvalApply: "failed" })
    expect(screen.getByRole("note")).toHaveTextContent("Silo could not apply the approval change.")
    expect(screen.getByRole("note")).not.toHaveTextContent("may still act without asking")
  })
  it("says some agents may still ask when a switch to auto failed", () => {
    render_({ ...ready, approval: "auto", appliedApproval: "ask", approvalApply: "failed" })
    expect(screen.getByRole("note")).toHaveTextContent("Some may still ask first.")
    expect(screen.queryByText(/still act without asking/)).toBeNull()
  })
  it("warns for an older owner that omits approvalApply when the chosen mode differs from the applied one", () => {
    // Parsed from a payload without an apply status.
    const older = (approval: string, appliedApproval: string) => parse({ state: "ready", approval, appliedApproval })!
    expect(older("ask", "auto").approvalApply).toBe("unknown")
    const { unmount } = render_(older("ask", "auto"))
    expect(screen.getByRole("note")).toHaveTextContent("Agents may still act without asking until this is applied.")
    expect(screen.queryByText("Applying…")).toBeNull()
    unmount()
    const second = render_(older("auto", "ask"))
    expect(screen.getByRole("note")).toHaveTextContent("Agents may still ask first until this is applied.")
    second.unmount()
    // Matching modes, or an applied mode that is not known, stay quiet.
    for (const computerUse of [older("ask", "ask"), older("auto", "auto"), older("ask", "unknown")]) {
      const { unmount: done } = render_(computerUse)
      expect(screen.queryByRole("note")).toBeNull()
      done()
    }
  })
  it.each([undefined, null, "sometime", 3, "unknown", "applied", "pending", "failed", "partial"])("preserves both mismatch warnings for approvalApply %j", approvalApply => {
    for (const [approval, appliedApproval, warning] of [
      ["ask", "auto", /may still act without asking/],
      ["auto", "ask", /may still ask first/],
    ]) {
      const parsed = parse({ state: "ready", approval, appliedApproval, ...(approvalApply === undefined ? {} : { approvalApply }) })!
      expect(parsed.approvalApply).toBe(["applied", "pending", "failed", "partial"].includes(String(approvalApply)) ? approvalApply : "unknown")
      const { unmount } = render_(parsed)
      expect(screen.getByRole("note")).toHaveTextContent(warning)
      expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeEnabled()
      expect(screen.getByRole("switch", { name: /Allow without asking/ })).toHaveAttribute("aria-checked", String(approval === "auto"))
      expect(screen.getByText(/Not a security boundary/)).toBeVisible()
      if (approvalApply !== "pending") expect(screen.queryByText("Applying…")).toBeNull()
      unmount()
    }
  })
  it("shows no approval note when applied, or while a first apply waits with nothing known", () => {
    for (const computerUse of [ready, fixtureComputerUse("auto"), { ...ready, approval: "auto" as const, appliedApproval: "unknown" as const },
      { ...ready, appliedApproval: "unknown" as const, approvalApply: "pending" as const }]) {
      const { unmount } = render_(computerUse)
      expect(screen.queryByRole("note")).toBeNull()
      unmount()
    }
  })
  it("keeps the unreadable-policy diagnostic alone, never a second warning", () => {
    render_({ ...ready, approval: "unknown", appliedApproval: "auto", approvalApply: "failed" })
    expect(screen.getAllByRole("note")).toHaveLength(1)
    expect(screen.getByRole("note")).toHaveTextContent("could not read the approval setting")
  })
  it("shows Applying… as soon as the switch is used, then the result the computer reports", async () => {
    const user = userEvent.setup()
    const change = deferred<unknown>()
    const reads = vi.fn(async () => ({ ...fixtureDesktopState("ready"), computerUse: fixtureComputerUse("auto") }))
    render(wrap(backend({ readDesktopState: reads, setApproval: () => change.promise }), <ComputerUseSection computer="office/vm-1" pollMs={60_000} />))
    await user.click(await screen.findByRole("switch", { name: /Allow without asking/ }))
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).not.toBeChecked()
    expect(screen.getByText("Applying…")).toBeVisible()
    await act(async () => { change.resolve({ ...fixtureDesktopState("ready"), computerUse: fixtureComputerUse("approval-failed") }) })
    expect(await screen.findByText(/Not applied to every agent/)).toBeVisible()
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).not.toBeChecked()
    expect(screen.queryByText("Applying…")).toBeNull()
  })
  it("reads the computer's state again after a command error instead of restoring the old snapshot", async () => {
    const user = userEvent.setup()
    // The command stored the choice and started applying it, then the answer was lost.
    const states = [fixtureComputerUse("auto"), { ...fixtureComputerUse("approval-pending"), approval: "ask" as const }]
    const readDesktopState = vi.fn(async () => ({ ...fixtureDesktopState("ready"), computerUse: states.length > 1 ? states.shift()! : states[0] }))
    render(wrap(backend({ readDesktopState, setApproval: async () => { throw new Error("The connection to office-mac was lost.") } }), <ComputerUseSection computer="office/vm-1" pollMs={60_000} />))
    expect(await screen.findByRole("switch", { name: /Allow without asking/ })).toBeChecked()
    await user.click(screen.getByRole("switch", { name: /Allow without asking/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("The connection to office-mac was lost.")
    // Not restored to the snapshot from before the change (auto): the authoritative state is ask, still applying.
    await waitFor(() => expect(screen.getByRole("switch", { name: /Allow without asking/ })).not.toBeChecked())
    expect(screen.getByText("Applying…")).toBeVisible()
    expect(screen.getByRole("note")).toHaveTextContent("may still act without asking")
    expect(readDesktopState).toHaveBeenCalledTimes(2)
  })
  it("keeps the old snapshot and says the read failed when the re-read fails too", async () => {
    const user = userEvent.setup()
    let reads = 0
    render(wrap(backend({
      readDesktopState: async () => { reads += 1; if (reads > 1) throw new Error("office-mac is offline"); return { ...fixtureDesktopState("ready"), computerUse: fixtureComputerUse("auto") } },
      setApproval: async () => { throw new Error("office-mac is offline") },
    }), <ComputerUseSection computer="office/vm-1" pollMs={60_000} />))
    await user.click(await screen.findByRole("switch", { name: /Allow without asking/ }))
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(2))
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
    expect(screen.getByRole("switch", { name: /Allow without asking/ })).toBeChecked()
  })
  it("applies in the fixture backend like the native one: stored at once, applied shortly after", async () => {
    const fixture = createFixtureComputerUseBackend("auto", "ready")
    const answered = parseLinuxDesktopState(await fixture.setApproval("w", "ask")).computerUse
    expect(answered).toMatchObject({ approval: "ask", appliedApproval: "auto", approvalApply: "pending" })
    await waitFor(async () => expect(parseLinuxDesktopState(await fixture.readDesktopState("w")).computerUse).toMatchObject({ appliedApproval: "ask", approvalApply: "applied" }), { timeout: 3000 })
  })
})

describe("approval copy", () => {
  it("is one line that does not claim every agent asks, and says it is not a security boundary", () => {
    const { container } = render(<ComputerUsePanel approval={controller(ready)} />)
    const text = container.textContent ?? ""
    expect(text).toMatch(/Claude Code and Codex/)
    expect(text).toMatch(/Not a security boundary/)
    expect(text).not.toMatch(/stay out of reach/)
    expect(screen.getAllByText(/security boundary/)).toHaveLength(1)
  })
})
