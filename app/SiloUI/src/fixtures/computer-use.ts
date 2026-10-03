import type { ComputerUseBackend } from "@/desktop/computer-use-bridge"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { ChatGptAppStatus, ComputerUseState, LinuxDesktopState } from "@/desktop/linux-desktop-state"
import { computerUseStates } from "@/desktop/linux-desktop-state"

// Deterministic fixtures for built-in computer use. Select with `?computer-use=<name>`,
// `&chatgpt=<name>` (this device's ChatGPT app) and `&chatgpt-remote=<name>` (every remote
// device's) in the browser preview; nothing here reaches Silo services.
export const computerUseFixtureNames = [...computerUseStates, "untested", "auto", "unknown-approval", "approval-pending", "approval-failed", "approval-partial", "app-failed", "pre-v4"] as const
export type ComputerUseFixtureName = typeof computerUseFixtureNames[number]
export const chatGptFixtureNames = ["idle", "downloading", "verifying", "extracting", "ready", "failed", "failed-final", "unknown", "ready-then-unreadable"] as const
export type ChatGptFixtureName = typeof chatGptFixtureNames[number]

export function computerUseFixtureFromSearch(search: string): ComputerUseFixtureName | undefined {
  const requested = new URLSearchParams(search).get("computer-use")
  return computerUseFixtureNames.find(name => name === requested)
}
export function chatGptFixtureFromSearch(search: string, parameter = "chatgpt"): ChatGptFixtureName | undefined {
  const requested = new URLSearchParams(search).get(parameter)
  return chatGptFixtureNames.find(name => name === requested)
}

export function fixtureComputerUse(name: ComputerUseFixtureName): ComputerUseState {
  const base: ComputerUseState = {
    state: "ready", reason: null, compatibility: "tested", warning: null, approval: "ask", appliedApproval: "ask", approvalApply: "applied", approvalApplyReason: null,
    appVersion: "26.928.31416", runtimeVersion: "0.0.14", lcuVersion: "0.8.0", agents: ["Claude Code", "Codex"],
  }
  switch (name) {
    case "unavailable": return { ...base, state: "unavailable", reason: "This sandbox was created before computer use was built in.", agents: null }
    case "preparing": return { ...base, state: "preparing", reason: "Preparing ChatGPT for Linux.", appVersion: null, runtimeVersion: null, lcuVersion: null, agents: null }
    case "installing": return { ...base, state: "installing", reason: "Configuring Claude Code and Codex." }
    case "failed": return { ...base, state: "failed", reason: "No supported agent was found. Install one, then set up computer use again.", agents: [] }
    case "app-failed": return { ...base, state: "failed", cause: "app-download", reason: "The downloaded file did not match the expected checksum. It was removed.", appVersion: null, runtimeVersion: null, lcuVersion: null, agents: null }
    case "untested": return { ...base, compatibility: "untested", warning: "ChatGPT for Linux 26.1002.1 has not been tested with this version of Silo. Computer use may not work as expected." }
    case "auto": return { ...base, approval: "auto", appliedApproval: "auto" }
    case "unknown-approval": return { ...base, approval: "unknown", appliedApproval: "unknown" }
    // The user turned it off; Silo is applying it and the agents still have the old setting.
    case "approval-pending": return { ...base, approval: "ask", appliedApproval: "auto", approvalApply: "pending" }
    // Silo could not apply it: nothing is assumed rolled back.
    case "approval-failed": return { ...base, approval: "ask", appliedApproval: "auto", approvalApply: "failed", approvalApplyReason: "Applying took too long. Silo tries again when the sandbox starts." }
    case "approval-partial": return { ...base, approval: "ask", appliedApproval: "auto", approvalApply: "partial", approvalApplyReason: "Some agents could not be configured. Details are in /var/log/silo-computer-use.log in the sandbox." }
    default: return base
  }
}

export function fixtureDesktopState(name: ComputerUseFixtureName): LinuxDesktopState {
  const common = { installed: true, autoStart: true, state: "running" as const, sessionState: "running" as const, streamState: "running" as const }
  return name === "pre-v4"
    ? { ...common, lcuState: "needs-runtime", lcuReason: "Install the official ChatGPT app in this sandbox." }
    : { ...common, computerUse: fixtureComputerUse(name) }
}

export function fixtureChatGptStatus(name: ChatGptFixtureName): ChatGptAppStatus {
  switch (name) {
    case "downloading": return { state: "downloading", receivedBytes: 187_000_000, totalBytes: 453_000_000 }
    case "ready": return { state: "ready", path: "/chatgpt/26.928.31416-arm64", version: "26.928.31416" }
    case "failed": return { state: "failed", reason: "The connection to OpenAI was interrupted.", retryable: true }
    case "failed-final": return { state: "failed", reason: "The downloaded file did not match the expected checksum. It was removed.", retryable: false }
    // Readable once, then every read fails: the last status stays on screen as "last known".
    case "ready-then-unreadable": return fixtureChatGptStatus("ready")
    case "idle": case "verifying": case "extracting": case "unknown": return { state: name }
  }
}

/** Two connected devices for the per-device ChatGPT status in Settings: one online, one offline. */
export function withDevicesFixture(source: ApplicationSource): ApplicationSource {
  return {
    ...source,
    devices: [
      { id: "11111111-1111-4111-8111-111111111111", name: "Office Mac", address: "ana@office.local", connected: true },
      { id: "22222222-2222-4222-8222-222222222222", name: "Studio PC", address: "ana@studio.local", connected: false },
    ],
  }
}

/** Marks the first VM as having a built-in desktop (or an older optional one). */
export function withComputerUseFixture(source: ApplicationSource, name: ComputerUseFixtureName): ApplicationSource {
  return {
    ...source,
    workspaces: source.workspaces.map((workspace, index) => index === 0 && workspace.machine.kind === "vm"
      ? { ...workspace, machine: { ...workspace.machine, desktop: name === "pre-v4" ? { startWithSandbox: true } : { startWithSandbox: true, builtIn: true } } }
      : workspace),
  }
}

/** A backend that behaves like the native one against in-memory state, with timers for progress.
 * `chatgpt` is this device's ChatGPT app, `remote` every remote device's. */
export function createFixtureComputerUseBackend(name: ComputerUseFixtureName, chatgpt: ChatGptFixtureName, remote: ChatGptFixtureName = chatgpt): ComputerUseBackend {
  let desktop = fixtureDesktopState(name)
  const statuses = new Map<string, ChatGptAppStatus>()
  const key = (device?: string) => device ?? ""
  const statusOf = (device?: string) => statuses.get(key(device)) ?? fixtureChatGptStatus(device ? remote : chatgpt)
  const reads = new Map<string, number>()
  const handlers = new Set<(status: unknown) => void>()
  const emit = (device: string | undefined, next: ChatGptAppStatus) => { statuses.set(key(device), next); if (!device) handlers.forEach(handler => handler(next)) }
  const delay = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
  const setUse = (patch: Partial<ComputerUseState>) => { if (desktop.computerUse) desktop = { ...desktop, computerUse: { ...desktop.computerUse, ...patch } } }
  return {
    readDesktopState: async () => structuredClone(desktop),
    // Like the native one: the choice is stored at once and applied in the background.
    setApproval: async (_workspace, mode) => {
      setUse({ approval: mode, approvalApply: "pending", approvalApplyReason: null })
      window.setTimeout(() => setUse({ appliedApproval: mode, approvalApply: "applied" }), 900)
      return structuredClone(desktop)
    },
    setup: async () => { await delay(900); setUse({ state: "ready", reason: null, cause: null }); return structuredClone(desktop) },
    chatGptStatus: async device => {
      if (device && remote === "ready-then-unreadable" && reads.get(device)) throw new Error("The SSH connection to this device was lost.")
      reads.set(key(device), 1)
      return statusOf(device)
    },
    retry: async device => {
      void (async () => {
        for (const received of [60_000_000, 190_000_000, 340_000_000, 453_000_000]) { emit(device, { state: "downloading", receivedBytes: received, totalBytes: 453_000_000 }); await delay(500) }
        emit(device, { state: "verifying" }); await delay(500)
        emit(device, { state: "extracting" }); await delay(500)
        emit(device, { state: "ready", path: "/chatgpt/26.928.31416-arm64", version: "26.928.31416" })
        if (!device) setUse({ state: "ready", reason: null, cause: null })
      })()
      return statusOf(device)
    },
    listenStatus: async handler => { handlers.add(handler); return () => { handlers.delete(handler) } },
  }
}
