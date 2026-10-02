import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { parseRemoteWorkspaceTarget, remoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { chatGptAppStatusSchema, parseLinuxDesktopState, type ChatGptAppStatus, type ComputerUseApproval, type LinuxDesktopState } from "./linux-desktop-state"

/** What built-in computer use needs from its host: the native commands in production,
 * deterministic fixtures in the browser preview. The ChatGPT app commands take the
 * workspace of a sandbox on another computer (omitted: this computer) and the backend
 * routes them to the computer that owns it. */
export interface ComputerUseBackend {
  readDesktopState(workspace: string): Promise<unknown>
  setApproval(workspace: string, mode: ComputerUseApproval): Promise<unknown>
  setup(workspace: string): Promise<unknown>
  chatGptStatus(workspace?: string): Promise<unknown>
  acceptNotice(workspace?: string): Promise<unknown>
  prepare(workspace?: string): Promise<unknown>
  /** Subscribes to `chatgpt-app-status` events (their `computer` field names the computer,
   * null for this one); resolves to an unsubscribe function. */
  listenStatus(handler: (status: unknown) => void): Promise<() => void>
}

export const nativeComputerUseBackend: ComputerUseBackend = {
  readDesktopState: workspace => invoke("read_desktop_state", { workspace }),
  setApproval: (workspace, mode) => invoke("set_computer_use_approval", { workspace, mode }),
  setup: workspace => invoke("desktop_action", { workspace, action: "setup-computer-use" }),
  chatGptStatus: workspace => invoke("chatgpt_app_status", { workspace }),
  acceptNotice: workspace => invoke("chatgpt_app_accept_notice", { workspace }),
  prepare: workspace => invoke("chatgpt_app_prepare", { workspace }),
  listenStatus: handler => listen("chatgpt-app-status", event => handler(event.payload)),
}

export interface ChatGptAppSnapshot {
  status: ChatGptAppStatus | null
  /** Set while accepting or starting the download; the download itself reports through `status`. */
  busy: boolean
  /** The last accept or download request failed. Kept until the next request or `dismissError`. */
  error: string | null
  /** The status could not be read. Cleared by the next successful read or event. */
  loadError: string | null
  /** "Not now" was chosen on this computer during this session. */
  dismissed: boolean
}

export interface ChatGptAppStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ChatGptAppSnapshot
  refresh(): Promise<void>
  /** Records the one-time consent, then starts the download. */
  accept(): Promise<void>
  /** Starts or retries the download. */
  prepare(): Promise<void>
  dismiss(): void
  dismissError(): void
}

export interface ComputerUseBridge {
  readState(workspace: string): Promise<LinuxDesktopState>
  setApproval(workspace: string, mode: ComputerUseApproval): Promise<LinuxDesktopState>
  setup(workspace: string): Promise<LinuxDesktopState>
  /** The shared ChatGPT app store of one computer: this one (omitted) or the one that owns
   * `workspace`, which may be a sandbox target or `computerWorkspace(hostId)`. */
  chatGptFor(workspace?: string): ChatGptAppStore
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const LOCAL = "local"
const NO_VM = "00000000-0000-0000-0000-000000000000"

/** A workspace target that routes ChatGPT app commands to a computer before it has any sandbox. */
export const computerWorkspace = (hostId: string | undefined) => hostId ? remoteWorkspaceTarget(hostId, NO_VM) : undefined

function computerKey(workspace: string | undefined) {
  if (!workspace) return LOCAL
  try { return parseRemoteWorkspaceTarget(workspace)?.hostId ?? LOCAL } catch { return workspace }
}
const eventKey = (payload: unknown) => {
  const computer = typeof payload === "object" && payload !== null ? (payload as { computer?: unknown }).computer : undefined
  return typeof computer === "string" && computer ? computer : LOCAL
}

function createChatGptAppStore(backend: ComputerUseBackend, key: string, target: string | undefined): ChatGptAppStore {
  let snapshot: ChatGptAppSnapshot = { status: null, busy: false, error: null, loadError: null, dismissed: false }
  const listeners = new Set<() => void>()
  let stopListening: (() => void) | null = null
  // Every event bumps `events`; a read that began before one is older than it and is dropped.
  let events = 0
  let reads = 0
  let generation = 0
  const set = (next: Partial<ChatGptAppSnapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(listener => listener()) }
  const parse = (value: unknown) => {
    const parsed = chatGptAppStatusSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  }
  // A status from a newer Silo that this one cannot read leaves the last one in place.
  const receive = (value: unknown) => {
    const status = parse(value)
    if (!status) return
    events += 1
    set({ status, loadError: null })
  }
  const refresh = async () => {
    const read = ++reads
    const seenEvents = events
    try {
      const value = await backend.chatGptStatus(target)
      if (read !== reads || seenEvents !== events) return
      const status = parse(value)
      if (status) set({ status, loadError: null })
      else if (!snapshot.status) set({ loadError: "Silo could not read the ChatGPT for Linux status." })
    } catch (cause) { if (read === reads) set({ loadError: message(cause) }) }
  }
  const prepare = async () => {
    set({ busy: true, error: null })
    try { await backend.prepare(target) } catch (cause) { set({ error: message(cause) }) } finally { set({ busy: false }) }
    await refresh()
  }
  const start = () => {
    const mine = ++generation
    backend.listenStatus(payload => { if (mine === generation && eventKey(payload) === key) receive(payload) })
      .then(stop => {
        if (mine !== generation) { stop(); return }
        stopListening = stop
        // Read only once events are being heard, so none can fall between the two.
        void refresh()
      }, () => { if (mine === generation) void refresh() })
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) { generation += 1; stopListening?.(); stopListening = null }
      }
    },
    getSnapshot: () => snapshot,
    refresh,
    prepare,
    dismiss: () => set({ dismissed: true }),
    dismissError: () => set({ error: null }),
    async accept() {
      set({ busy: true, error: null })
      try { await backend.acceptNotice(target) } catch (cause) { set({ busy: false, error: message(cause) }); await refresh(); return }
      await prepare()
    },
  }
}

export function createComputerUseBridge(backend: ComputerUseBackend): ComputerUseBridge {
  const stores = new Map<string, ChatGptAppStore>()
  return {
    readState: async workspace => parseLinuxDesktopState(await backend.readDesktopState(workspace)),
    setApproval: async (workspace, mode) => parseLinuxDesktopState(await backend.setApproval(workspace, mode)),
    setup: async workspace => parseLinuxDesktopState(await backend.setup(workspace)),
    chatGptFor(workspace) {
      const key = computerKey(workspace)
      let store = stores.get(key)
      if (!store) {
        // The owner is all the backend needs, so every store of a computer targets it the same way.
        let hostId: string | undefined
        try { hostId = parseRemoteWorkspaceTarget(workspace ?? "")?.hostId } catch { hostId = undefined }
        store = createChatGptAppStore(backend, key, key === LOCAL ? undefined : hostId ? computerWorkspace(hostId) : workspace)
        stores.set(key, store)
      }
      return store
    },
  }
}

const ComputerUseContext = createContext<ComputerUseBridge | null>(null)

/** Its presence means this build creates VMs with the built-in desktop. */
export function ComputerUseProvider({ bridge, children }: { bridge: ComputerUseBridge; children: ReactNode }) {
  return <ComputerUseContext.Provider value={bridge}>{children}</ComputerUseContext.Provider>
}

export function useComputerUseBridge() { return useContext(ComputerUseContext) }

const emptySnapshot: ChatGptAppSnapshot = { status: null, busy: false, error: null, loadError: null, dismissed: false }
const noopSubscribe = () => () => {}
const emptyStore = () => emptySnapshot
export function useChatGptApp(store: ChatGptAppStore | undefined): ChatGptAppSnapshot {
  return useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : emptyStore)
}
