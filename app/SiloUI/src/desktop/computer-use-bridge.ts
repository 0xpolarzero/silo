import { createContext, useContext, useSyncExternalStore } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { parseRemoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { chatGptAppStatusSchema, parseChatGptAppStatus, parseLinuxDesktopState, type ChatGptAppStatus, type ComputerUseApproval, type LinuxDesktopState } from "./linux-desktop-state"

/** What built-in computer use needs from its host: the native commands in production,
 * deterministic fixtures in the browser preview. Every computer downloads the ChatGPT app
 * by itself; the commands only read its status and ask it to try again. They take the host
 * id of a remote computer (omitted: this computer). */
export interface ComputerUseBackend {
  readDesktopState(workspace: string): Promise<unknown>
  setApproval(workspace: string, mode: ComputerUseApproval): Promise<unknown>
  setup(workspace: string): Promise<unknown>
  chatGptStatus(computer?: string): Promise<unknown>
  /** Asks the computer to download the app again now. Resolves at once; progress follows from the status. */
  retry(computer?: string): Promise<unknown>
  /** Subscribes to `chatgpt-app-status` events of this computer; resolves to an unsubscribe function. */
  listenStatus(handler: (status: unknown) => void): Promise<() => void>
}

export const nativeComputerUseBackend: ComputerUseBackend = {
  readDesktopState: workspace => invoke("read_desktop_state", { workspace }),
  setApproval: (workspace, mode) => invoke("set_computer_use_approval", { workspace, mode }),
  setup: workspace => invoke("desktop_action", { workspace, action: "setup-computer-use" }),
  chatGptStatus: computer => invoke("chatgpt_app_status", { computer }),
  retry: computer => invoke("chatgpt_app_retry", { computer }),
  listenStatus: handler => listen("chatgpt-app-status", event => handler(event.payload)),
}

export interface ChatGptAppSnapshot {
  status: ChatGptAppStatus | null
  /** Set while a retry request is in flight. */
  busy: boolean
  /** The last retry request failed. Kept until the next request or `dismissError`. */
  error: string | null
  /** The status could not be read. Cleared by the next successful read or event. */
  loadError: string | null
  /** Local status events are unavailable. Cleared when listener registration succeeds. */
  subscriptionError: string | null
}

export interface ChatGptAppStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ChatGptAppSnapshot
  refresh(): Promise<void>
  /** Asks the computer to try the download again now. */
  retry(): Promise<void>
  dismissError(): void
}

export interface ComputerUseBridge {
  readState(workspace: string): Promise<LinuxDesktopState>
  setApproval(workspace: string, mode: ComputerUseApproval): Promise<LinuxDesktopState>
  setup(workspace: string): Promise<LinuxDesktopState>
  /** The ChatGPT app store of one computer: this one (omitted) or the remote computer with that host id. */
  chatGptFor(computer?: string): ChatGptAppStore
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const LOCAL = "local"
// A remote computer's status has no events: it is read again on this schedule.
const REMOTE_BUSY_POLL_MS = 3000
const REMOTE_IDLE_POLL_MS = 15000
const working = (status: ChatGptAppStatus | null) => status?.state === "downloading" || status?.state === "verifying" || status?.state === "extracting" || status?.state === "idle"

/** The host id of the computer that owns a sandbox workspace target, undefined for a local sandbox. */
export function computerOfWorkspace(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined
  try { return parseRemoteWorkspaceTarget(workspace)?.hostId } catch { return undefined }
}

function createChatGptAppStore(backend: ComputerUseBackend, computer: string | undefined, pollMs = { busy: REMOTE_BUSY_POLL_MS, idle: REMOTE_IDLE_POLL_MS }): ChatGptAppStore {
  let snapshot: ChatGptAppSnapshot = { status: null, busy: false, error: null, loadError: null, subscriptionError: null }
  const listeners = new Set<() => void>()
  let stopListening: (() => void) | null = null
  let timer: number | undefined
  let onVisibilityChange: (() => void) | undefined
  // Every event bumps `events`; a read that began before one is older than it and is dropped.
  let events = 0
  let reads = 0
  let generation = 0
  const set = (next: Partial<ChatGptAppSnapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(listener => listener()) }
  // An event this Silo cannot read leaves the last status in place.
  const receive = (value: unknown) => {
    const parsed = chatGptAppStatusSchema.safeParse(value)
    if (!parsed.success) return
    events += 1
    set({ status: parsed.data, loadError: null })
  }
  const refresh = async () => {
    const read = ++reads
    const seenEvents = events
    try {
      const value = await backend.chatGptStatus(computer)
      if (read !== reads || seenEvents !== events) return
      const status = parseChatGptAppStatus(value)
      if (status) set({ status, loadError: null })
      else if (!snapshot.status) set({ loadError: "Silo could not read the ChatGPT for Linux status." })
    } catch (cause) { if (read === reads && seenEvents === events) set({ loadError: message(cause) }) }
  }
  const retry = async () => {
    set({ busy: true, error: null })
    try { await backend.retry(computer) } catch (cause) { set({ error: message(cause) }) } finally { set({ busy: false }) }
    await refresh()
  }
  const schedule = (mine: number) => {
    if (computer === undefined) return
    window.clearTimeout(timer)
    if (document.visibilityState === "hidden") return
    timer = window.setTimeout(() => {
      if (mine !== generation || document.visibilityState === "hidden") return
      void refresh().finally(() => { if (mine === generation) schedule(mine) })
    }, working(snapshot.status) ? pollMs.busy : pollMs.idle)
  }
  const start = () => {
    const mine = ++generation
    const begin = () => {
      if (mine !== generation || (computer !== undefined && document.visibilityState === "hidden")) return
      void refresh().finally(() => { if (mine === generation) schedule(mine) })
    }
    let retryDelay = 1000
    let registering = false
    const register = () => {
      if (mine !== generation || registering) return
      registering = true
      backend.listenStatus(payload => { if (mine === generation && computer === undefined) receive(payload) })
        .then(stop => {
          if (mine !== generation) { stop(); return }
          registering = false
          stopListening = stop
          set({ subscriptionError: null })
          // Read only once events are being heard, so none can fall between the two.
          begin()
        }, cause => {
          if (mine !== generation) return
          registering = false
          if (computer === undefined) {
            set({ subscriptionError: `Silo could not subscribe to ChatGPT for Linux updates: ${message(cause)}` })
            if (document.visibilityState !== "hidden") {
              timer = window.setTimeout(register, retryDelay)
              retryDelay = Math.min(retryDelay * 2, 30_000)
            }
          }
          begin()
        })
    }
    onVisibilityChange = () => {
      window.clearTimeout(timer)
      if (document.visibilityState === "hidden") return
      if (computer !== undefined) begin()
      else if (snapshot.subscriptionError) register()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    register()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          generation += 1
          reads += 1
          stopListening?.()
          stopListening = null
          window.clearTimeout(timer)
          if (onVisibilityChange) document.removeEventListener("visibilitychange", onVisibilityChange)
          onVisibilityChange = undefined
        }
      }
    },
    getSnapshot: () => snapshot,
    refresh,
    retry,
    dismissError: () => set({ error: null }),
  }
}

export function createComputerUseBridge(backend: ComputerUseBackend, pollMs?: { busy: number; idle: number }): ComputerUseBridge {
  const stores = new Map<string, ChatGptAppStore>()
  return {
    readState: async workspace => parseLinuxDesktopState(await backend.readDesktopState(workspace)),
    setApproval: async (workspace, mode) => parseLinuxDesktopState(await backend.setApproval(workspace, mode)),
    setup: async workspace => parseLinuxDesktopState(await backend.setup(workspace)),
    chatGptFor(computer) {
      const key = computer || LOCAL
      let store = stores.get(key)
      if (!store) {
        store = createChatGptAppStore(backend, computer || undefined, pollMs)
        stores.set(key, store)
      }
      return store
    },
  }
}

export const ComputerUseContext = createContext<ComputerUseBridge | null>(null)

export function useComputerUseBridge() { return useContext(ComputerUseContext) }

const emptySnapshot: ChatGptAppSnapshot = { status: null, busy: false, error: null, loadError: null, subscriptionError: null }
const noopSubscribe = () => () => {}
const emptyStore = () => emptySnapshot
export function useChatGptApp(store: ChatGptAppStore | undefined, active = true): ChatGptAppSnapshot {
  return useSyncExternalStore(store && active ? store.subscribe : noopSubscribe, store ? store.getSnapshot : emptyStore)
}
