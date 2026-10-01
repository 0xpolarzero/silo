import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { chatGptAppStatusSchema, parseLinuxDesktopState, type ChatGptAppStatus, type ComputerUseApproval, type LinuxDesktopState } from "./linux-desktop-state"

/** What built-in computer use needs from its host: the native commands in production,
 * deterministic fixtures in the browser preview. Remote computers are routed by the backend. */
export interface ComputerUseBackend {
  readDesktopState(workspace: string): Promise<unknown>
  setApproval(workspace: string, mode: ComputerUseApproval): Promise<unknown>
  setup(workspace: string): Promise<unknown>
  chatGptStatus(): Promise<unknown>
  acceptNotice(): Promise<unknown>
  prepare(): Promise<unknown>
  /** Subscribes to `chatgpt-app-status` events; resolves to an unsubscribe function. */
  listenStatus(handler: (status: unknown) => void): Promise<() => void>
}

export const nativeComputerUseBackend: ComputerUseBackend = {
  readDesktopState: workspace => invoke("read_desktop_state", { workspace }),
  setApproval: (workspace, mode) => invoke("set_computer_use_approval", { workspace, mode }),
  setup: workspace => invoke("desktop_action", { workspace, action: "setup-computer-use" }),
  chatGptStatus: () => invoke("chatgpt_app_status"),
  acceptNotice: () => invoke("chatgpt_app_accept_notice"),
  prepare: () => invoke("chatgpt_app_prepare"),
  listenStatus: handler => listen("chatgpt-app-status", event => handler(event.payload)),
}

export interface ChatGptAppSnapshot {
  status: ChatGptAppStatus | null
  /** Set while accepting or starting the download; the download itself reports through `status`. */
  busy: boolean
  error: string | null
}

export interface ChatGptAppStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ChatGptAppSnapshot
  refresh(): Promise<void>
  /** Records the one-time consent, then starts the download. */
  accept(): Promise<void>
  /** Starts or retries the download. */
  prepare(): Promise<void>
}

export interface ComputerUseBridge {
  readState(workspace: string): Promise<LinuxDesktopState>
  setApproval(workspace: string, mode: ComputerUseApproval): Promise<LinuxDesktopState>
  setup(workspace: string): Promise<LinuxDesktopState>
  chatGpt: ChatGptAppStore
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

function createChatGptAppStore(backend: ComputerUseBackend): ChatGptAppStore {
  let snapshot: ChatGptAppSnapshot = { status: null, busy: false, error: null }
  const listeners = new Set<() => void>()
  let stopListening: (() => void) | null = null
  let listening = false
  const set = (next: Partial<ChatGptAppSnapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(listener => listener()) }
  // A status from a newer Silo that this one cannot read leaves the last one in place.
  const receive = (value: unknown) => {
    const parsed = chatGptAppStatusSchema.safeParse(value)
    if (parsed.success) set({ status: parsed.data })
  }
  const refresh = async () => {
    try { receive(await backend.chatGptStatus()) } catch (cause) { set({ error: message(cause) }) }
  }
  const prepare = async () => {
    set({ busy: true, error: null })
    try { await backend.prepare() } catch (cause) { set({ error: message(cause) }) } finally { set({ busy: false }) }
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!listening) {
        listening = true
        void backend.listenStatus(receive).then(stop => { if (listening) stopListening = stop; else stop() }).catch(() => {})
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) { listening = false; stopListening?.(); stopListening = null }
      }
    },
    getSnapshot: () => snapshot,
    refresh,
    prepare,
    async accept() {
      set({ busy: true, error: null })
      try { await backend.acceptNotice() } catch (cause) { set({ busy: false, error: message(cause) }); return }
      await prepare()
    },
  }
}

export function createComputerUseBridge(backend: ComputerUseBackend): ComputerUseBridge {
  return {
    readState: async workspace => parseLinuxDesktopState(await backend.readDesktopState(workspace)),
    setApproval: async (workspace, mode) => parseLinuxDesktopState(await backend.setApproval(workspace, mode)),
    setup: async workspace => parseLinuxDesktopState(await backend.setup(workspace)),
    chatGpt: createChatGptAppStore(backend),
  }
}

const ComputerUseContext = createContext<ComputerUseBridge | null>(null)

/** Its presence means this build creates VMs with the built-in desktop. */
export function ComputerUseProvider({ bridge, children }: { bridge: ComputerUseBridge; children: ReactNode }) {
  return <ComputerUseContext.Provider value={bridge}>{children}</ComputerUseContext.Provider>
}

export function useComputerUseBridge() { return useContext(ComputerUseContext) }

const emptySnapshot: ChatGptAppSnapshot = { status: null, busy: false, error: null }
const noopSubscribe = () => () => {}
const emptyStore = () => emptySnapshot
export function useChatGptApp(store: ChatGptAppStore | undefined): ChatGptAppSnapshot {
  return useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : emptyStore)
}
