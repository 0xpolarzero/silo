import type { ComputerUseBackend } from "@/desktop/computer-use-bridge"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { ChatGptAppStatus, ComputerUseState, LinuxDesktopState } from "@/desktop/linux-desktop-state"
import { computerUseStates } from "@/desktop/linux-desktop-state"

// Deterministic fixtures for built-in computer use. Select with `?computer-use=<name>`,
// `&chatgpt=<name>` (this computer's ChatGPT app) and `&chatgpt-remote=<name>` (every remote
// computer's) in the browser preview; nothing here reaches Silo services.
export const computerUseFixtureNames = [...computerUseStates, "untested", "auto", "unknown-approval", "unapplied-ask", "app-failed", "pre-v4"] as const
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
    state: "ready", reason: null, compatibility: "tested", warning: null, approval: "ask", appliedApproval: "ask",
    appVersion: "26.928.31416", runtimeVersion: "0.0.14", lcuVersion: "0.8.0", agents: ["Claude Code", "Codex"],
  }
  switch (name) {
    case "unavailable": return { ...base, state: "unavailable", reason: "This sandbox was created before computer use was built in.", agents: null }
    case "preparing": return { ...base, state: "preparing", reason: "Preparing ChatGPT for Linux.", appVersion: null, runtimeVersion: null, lcuVersion: null, agents: null }
    case "installing": return { ...base, state: "installing", reason: "Configuring Claude Code and Codex." }
    case "failed": return { ...base, state: "failed", reason: "No supported agent was found. Install one, then choose Set up computer use.", agents: [] }
    case "app-failed": return { ...base, state: "failed", cause: "app-download", reason: "The downloaded file did not match the expected checksum. It was removed.", appVersion: null, runtimeVersion: null, lcuVersion: null, agents: null }
    case "untested": return { ...base, compatibility: "untested", warning: "ChatGPT for Linux 26.1002.1 has not been tested with this version of Silo. Computer use may not work as expected." }
    case "auto": return { ...base, approval: "auto", appliedApproval: "auto" }
    case "unknown-approval": return { ...base, approval: "unknown", appliedApproval: "unknown" }
    // The user turned it off, but the guest still auto-approves.
    case "unapplied-ask": return { ...base, approval: "ask", appliedApproval: "auto", state: "installing", reason: "Applying approval change…" }
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

/** Two connected computers for the per-computer ChatGPT status in Settings: one online, one offline. */
export function withRemoteComputersFixture(source: ApplicationSource): ApplicationSource {
  return {
    ...source,
    remoteComputers: [
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
 * `chatgpt` is this computer's ChatGPT app, `remote` every remote computer's. */
export function createFixtureComputerUseBackend(name: ComputerUseFixtureName, chatgpt: ChatGptFixtureName, remote: ChatGptFixtureName = chatgpt): ComputerUseBackend {
  let desktop = fixtureDesktopState(name)
  const statuses = new Map<string, ChatGptAppStatus>()
  const key = (computer?: string) => computer ?? ""
  const statusOf = (computer?: string) => statuses.get(key(computer)) ?? fixtureChatGptStatus(computer ? remote : chatgpt)
  const reads = new Map<string, number>()
  const handlers = new Set<(status: unknown) => void>()
  const emit = (computer: string | undefined, next: ChatGptAppStatus) => { statuses.set(key(computer), next); if (!computer) handlers.forEach(handler => handler(next)) }
  const delay = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
  const setUse = (patch: Partial<ComputerUseState>) => { if (desktop.computerUse) desktop = { ...desktop, computerUse: { ...desktop.computerUse, ...patch } } }
  return {
    readDesktopState: async () => structuredClone(desktop),
    setApproval: async (_workspace, mode) => { setUse({ approval: mode, appliedApproval: mode }); return structuredClone(desktop) },
    setup: async () => { await delay(900); setUse({ state: "ready", reason: null, cause: null }); return structuredClone(desktop) },
    chatGptStatus: async computer => {
      if (computer && remote === "ready-then-unreadable" && reads.get(computer)) throw new Error("The SSH connection to this computer was lost.")
      reads.set(key(computer), 1)
      return statusOf(computer)
    },
    retry: async computer => {
      void (async () => {
        for (const received of [60_000_000, 190_000_000, 340_000_000, 453_000_000]) { emit(computer, { state: "downloading", receivedBytes: received, totalBytes: 453_000_000 }); await delay(500) }
        emit(computer, { state: "verifying" }); await delay(500)
        emit(computer, { state: "extracting" }); await delay(500)
        emit(computer, { state: "ready", path: "/chatgpt/26.928.31416-arm64", version: "26.928.31416" })
        if (!computer) setUse({ state: "ready", reason: null, cause: null })
      })()
      return statusOf(computer)
    },
    listenStatus: async handler => { handlers.add(handler); return () => { handlers.delete(handler) } },
  }
}
