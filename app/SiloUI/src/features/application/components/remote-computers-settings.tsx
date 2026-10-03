import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { showActionFailure } from "@/lib/operation-toast"
import { restoreFocus } from "@/lib/focus"
import { useComputerUseBridge, type ChatGptAppSnapshot, type ChatGptAppStore } from "@/desktop/computer-use-bridge"
import { useSettings } from "@/features/preferences/settings-store"
import { CHATGPT_DOWNLOAD_NOTE } from "@/desktop/computer-use-panel"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import type { RemoteManagement } from "../model/remote-computers"

// The backend refuses to move a saved computer to a new address unless the user confirms.
const alreadySaved = "is already saved at"

export function ConnectComputerForm({ connect, authorize, setupKey, onClose }: { setupKey?: (address: string) => Promise<void>; authorize?: (address: string) => Promise<void>; connect: (address: string, options?: { replaceAddress?: boolean }) => Promise<void>; onClose: () => void }) {
  const [address, setAddress] = useState("")
  const [operation, setOperation] = useState<"connect" | "authorize" | "setupKey" | null>(null)
  const busy = operation !== null
  // Connection failures stay inline: the form is where the user corrects the address, and the
  // SSH recovery actions below only make sense next to the error. Onboarding has no toaster.
  const [error, setError] = useState("")
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  async function attempt(action: () => Promise<void>, kind: "connect" | "authorize" | "setupKey" = "connect") {
    setOperation(kind)
    try { await action() } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) } finally { if (mounted.current) setOperation(null) }
  }
  return <form aria-label="Connect computer" className="grid gap-3 rounded-lg border p-3" onSubmit={async event => {
    event.preventDefault()
    if (!address.trim() || busy) return
    setError("")
    await attempt(async () => { await connect(address.trim()); if (mounted.current) onClose() })
  }}>
    <label className="grid gap-1 text-xs">Computer address<Input technical autoFocus aria-label="Computer address" placeholder="user@computer or SSH alias" value={address} disabled={busy} onChange={event => setAddress(event.target.value)} /></label>
    <p className="text-xs text-muted-foreground">Open Silo on that computer and enable remote management. Uses your existing SSH keys and configuration.</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {error.includes(alreadySaved) && <div className="grid justify-items-start gap-1"><Button type="button" variant="outline" size="sm" disabled={busy || !address.trim()} onClick={() => { void attempt(async () => { await connect(address.trim(), { replaceAddress: true }); if (mounted.current) onClose() }) }}>Use this address</Button><p className="text-xs text-muted-foreground">Only if that computer now uses this address. Its sandboxes and connections stay as they are.</p></div>}
    {error && !error.includes(alreadySaved) && authorize && <div className="grid justify-items-start gap-1"><Button type="button" variant="outline" size="sm" disabled={busy || !address.trim()} onClick={() => { void attempt(() => authorize(address.trim()), "authorize") }}>{operation === "authorize" ? "Opening Terminal…" : "Authorize SSH in Terminal…"}</Button><p className="text-xs text-muted-foreground">Confirm the computer’s fingerprint and unlock your SSH key, then connect again.</p></div>}
    {error && !error.includes(alreadySaved) && setupKey && <div className="grid justify-items-start gap-1"><Button type="button" variant="outline" size="sm" disabled={busy || !address.trim()} onClick={() => { void attempt(() => setupKey(address.trim()), "setupKey") }}>{operation === "setupKey" ? "Setting up SSH key…" : "Set up Silo SSH key…"}</Button><p className="text-xs text-muted-foreground">Adds Silo’s public SSH key to your account on the other computer. You may be asked for its password. Then connect again.</p></div>}
    <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" disabled={busy || !address.trim()}>{operation === "connect" ? "Connecting…" : "Connect"}</Button></div>
  </form>
}

const addressKinds = { name: "Local network name", tailscale: "Tailscale", network: "Local network" } as const

// A host name alone often does not resolve from another computer, so every candidate is offered.
function ManagementAddresses({ management }: { management: RemoteManagement }) {
  const addresses = management.addresses?.length ? management.addresses : [{ address: management.address, kind: "name" as const }]
  return <div className="grid gap-1">
    <p className="text-xs text-muted-foreground">Other computers can connect using one of these addresses.</p>
    <ul aria-label="Addresses for other computers" className="grid gap-1">
      {addresses.map(entry => <li key={entry.address} className="flex items-center justify-between gap-2">
        <span className="min-w-0"><code className="select-text break-all text-xs">{entry.address}</code> <span className="text-xs text-muted-foreground">{addressKinds[entry.kind]}</span></span>
        <CopyButton size="xs" variant="outline" value={entry.address} labels={{ idle: `Copy ${entry.address}`, copied: "Address copied", failed: "Copy failed" }} text={{ idle: "Copy", copied: "Copied", failed: "Copy failed" }} />
      </li>)}
    </ul>
  </div>
}

const noStatus: ChatGptAppSnapshot = { status: null, busy: false, error: null, loadError: null, subscriptionError: null }

/** The snapshots of several computers' stores together; the array is replaced only when one of them changed. */
function useChatGptApps(stores: Array<ChatGptAppStore | undefined>, active: boolean): ChatGptAppSnapshot[] {
  const last = useRef<ChatGptAppSnapshot[]>([])
  const subscribe = useCallback((listener: () => void) => {
    if (!active) return () => {}
    const stops = stores.map(store => store?.subscribe(listener))
    return () => stops.forEach(stop => stop?.())
  }, [stores, active])
  const getSnapshot = useCallback(() => {
    const next = stores.map(store => store?.getSnapshot() ?? noStatus)
    if (next.length === last.current.length && next.every((snapshot, index) => snapshot === last.current[index])) return last.current
    last.current = next
    return next
  }, [stores])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** One computer whose ChatGPT for Linux download failed or whose status cannot be read. The download itself runs by itself in the background. */
function ComputerUseProblemRow({ name, store, snapshot }: { name: string; store: ChatGptAppStore; snapshot: ChatGptAppSnapshot }) {
  const { status, busy, error, loadError, subscriptionError } = snapshot
  const failed = status?.state === "failed"
  return <li className="flex items-start justify-between gap-3">
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <p className="truncate text-xs font-medium" title={name}>{name}</p>
      {failed && <p role="alert" className="break-words text-xs text-destructive">{status.reason}{status.retryable ? " Silo tries again automatically." : ""}</p>}
      {subscriptionError && <p role="alert" className="break-words text-xs text-destructive">{subscriptionError}</p>}
      {loadError && <p role="alert" className="break-words text-xs text-destructive">{`Silo could not read the computer use status: ${loadError}`}</p>}
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    </div>
    <div className="flex shrink-0 gap-1.5">
      {(loadError || subscriptionError) && <Button size="xs" variant="outline" aria-label={`Refresh ChatGPT for Linux status on ${name}`} onClick={() => { void store.refresh() }}>Refresh</Button>}
      {failed && <Button size="xs" variant="outline" disabled={busy} aria-label={`Retry ChatGPT for Linux on ${name}`} onClick={() => { void store.retry() }}>Retry</Button>}
    </div>
  </li>
}

/** Appears only when a computer needs the user: every computer prepares ChatGPT for Linux by itself, so nothing shows while that works. */
function ComputerUseProblems({ source, active }: { source: ApplicationSource; active: boolean }) {
  const bridge = useComputerUseBridge()
  const computers = source.remoteComputers
  const entries = useMemo(() => bridge ? [
    { key: "local", name: "This computer", store: bridge.chatGptFor() },
    // An offline computer has no status to read: that is not a problem to act on.
    ...(computers ?? []).filter(computer => computer.connected).map(computer => ({ key: computer.id, name: computer.name, store: bridge.chatGptFor(computer.id) })),
  ] : [], [bridge, computers])
  const snapshots = useChatGptApps(useMemo(() => entries.map(entry => entry.store), [entries]), active)
  const problems = entries.flatMap((entry, index) => {
    const snapshot = snapshots[index] ?? noStatus
    return snapshot.status?.state === "failed" || snapshot.loadError || snapshot.subscriptionError ? [{ ...entry, snapshot }] : []
  })
  if (problems.length === 0) return null
  return <section aria-label="Computer use components" className="grid gap-3">
    <h2 className="text-xs font-medium">Computer use components</h2>
    <div className="grid gap-3 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{CHATGPT_DOWNLOAD_NOTE}</p>
      <ul aria-label="Computers that need attention" className="grid gap-3">
        {problems.map(problem => <ComputerUseProblemRow key={problem.key} name={problem.name} store={problem.store} snapshot={problem.snapshot} />)}
      </ul>
    </div>
  </section>
}

function NewSandboxApprovalSetting() {
  const { settings, updateSettings } = useSettings()
  if (!useComputerUseBridge()) return null
  return <section aria-label="Computer use" className="grid gap-3">
    <h2 className="text-xs font-medium">Computer use</h2>
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-4"><div><label htmlFor="computer-use-auto-approval" className="text-xs font-medium">Allow agents to use the computer without asking in new sandboxes</label><p className="text-xs text-muted-foreground">Claude Code, Codex and similar agents stop asking before using the sandbox’s desktop. Not a security boundary.</p></div><Switch id="computer-use-auto-approval" checked={settings.computerUseAutoApproval} onCheckedChange={enabled => { void updateSettings({ computerUseAutoApproval: enabled }) }} /></div>
    </div>
  </section>
}

export function RemoteComputersSettings({ source, actions, active = true }: { source: ApplicationSource; actions: ApplicationActions; active?: boolean }) {
  return <div className="grid gap-6">
    {actions.connectComputer && <ComputersSection source={source} actions={actions} />}
    <NewSandboxApprovalSetting />
    <ComputerUseProblems source={source} active={active} />
  </div>
}

function ComputersSection({ source, actions }: { source: ApplicationSource; actions: ApplicationActions }) {
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const connectButton = useRef<HTMLButtonElement>(null)
  const shouldRestoreFocus = useRef(false)
  useEffect(() => {
    if (!connecting && shouldRestoreFocus.current) {
      shouldRestoreFocus.current = false
      restoreFocus(connectButton.current)
    }
  }, [connecting])
  function closeConnectionForm() {
    shouldRestoreFocus.current = true
    setConnecting(false)
  }
  const pending = useRef(false)
  const unmounts = useRef(0)
  const generations = useRef(new Map<string, number>())
  useEffect(() => () => { unmounts.current++ }, [])
  async function perform(resource: string, operation: () => Promise<void>) {
    if (pending.current) return
    const epoch = unmounts.current
    const generation = (generations.current.get(resource) ?? 0) + 1
    generations.current.set(resource, generation)
    const current = () => epoch === unmounts.current && generation === generations.current.get(resource)
    pending.current = true
    setBusy(true)
    try { await operation() } catch (cause) {
      if (epoch === unmounts.current) showActionFailure("Computer setting not changed", cause, () => { if (current()) void perform(resource, operation) }, { native: false })
    } finally { if (epoch === unmounts.current) { pending.current = false; setBusy(false) } }
  }
  const removeComputer = actions.removeComputer
  if (!actions.connectComputer) return null
  return <section aria-label="Computers" className="grid gap-3">
    <h2 className="text-xs font-medium">Computers</h2>
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-4"><div><label htmlFor="remote-management" className="text-xs font-medium">Allow remote management</label><p className="text-xs text-muted-foreground">Let computers with SSH access to your account manage these sandboxes while Silo is running.</p><p className="text-xs text-muted-foreground">Quit stops local sandboxes and disconnects remote sessions.</p></div><Switch id="remote-management" checked={source.remoteManagement?.enabled ?? false} disabled={busy || !source.remoteManagement || !actions.setRemoteManagement} onCheckedChange={enabled => { void perform("remote-management", () => actions.setRemoteManagement!(enabled)) }} /></div>
      {source.remoteManagement?.error && <p role="alert" className="text-xs text-destructive">{source.remoteManagement.error}</p>}
      {source.remoteManagement?.enabled && <p className="text-xs text-muted-foreground">Enable Remote Login on macOS or the SSH server on Linux so other computers can connect.</p>}
      {source.remoteManagement?.enabled && <ManagementAddresses management={source.remoteManagement} />}
      {source.remoteComputers?.map(computer => <div key={computer.id} className="flex items-center justify-between gap-3 border-t pt-3"><div className="min-w-0 [overflow-wrap:anywhere]"><p className="truncate text-xs font-medium" title={computer.name}>{computer.name}</p><p className="text-xs text-muted-foreground">{computer.busy ? "Updating…" : computer.connected ? "Connected" : "Offline · last known status"} · {computer.address}</p>{computer.error && <p className="text-xs text-destructive">{computer.error}</p>}<p className="text-xs text-muted-foreground">Removing the connection leaves sandboxes on {computer.name} unchanged.</p></div><Button size="xs" variant="ghost" disabled={busy || !removeComputer} aria-label={`Remove connection to ${computer.name}`} onClick={() => { if (removeComputer) void perform(`computer:${computer.id}`, () => removeComputer(computer.id)) }}>Remove connection</Button></div>)}
      {!connecting && <Button ref={connectButton} size="sm" variant="outline" className="justify-self-start" onClick={() => setConnecting(true)}>Connect computer…</Button>}
      {connecting && <ConnectComputerForm connect={actions.connectComputer} authorize={actions.authorizeComputer} setupKey={actions.setupComputerKey} onClose={closeConnectionForm} />}
      {source.remoteComputersError && <p role="alert" className="text-xs text-destructive">{source.remoteComputersError}</p>}
      {source.remoteManagementError && <p role="alert" className="text-xs text-destructive">{source.remoteManagementError}</p>}
    </div>
  </section>
}
