import { useEffect, useRef, useState } from "react"
import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { showActionFailure } from "@/lib/operation-toast"
import { restoreFocus } from "@/lib/focus"
import { useChatGptApp, useComputerUseBridge } from "@/desktop/computer-use-bridge"
import { CHATGPT_DOWNLOAD_NOTE } from "@/desktop/computer-use-panel"
import { chatGptStatusText } from "@/desktop/computer-use-labels"
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

/** One computer's ChatGPT for Linux status. Every computer downloads it by itself; a failure can be retried here. */
function ChatGptAppRow({ name, computer, connected = true, active }: { name: string; computer?: string; connected?: boolean; active: boolean }) {
  const bridge = useComputerUseBridge()
  const store = connected ? bridge?.chatGptFor(computer) : undefined
  const { status, busy, error, loadError, subscriptionError } = useChatGptApp(store, active)
  const stale = Boolean(status) && Boolean(loadError)
  // An offline computer, or one whose Silo is older, simply has no status to show: unknown, never an error.
  const known = connected && status !== null && status.state !== "unknown"
  const text = known ? chatGptStatusText(status) : "Unknown"
  // After a failed read the retained status is only the last one seen, never current.
  const lastKnown = stale && known
  const failed = status?.state === "failed"
  const working = !stale && (status?.state === "downloading" || status?.state === "verifying" || status?.state === "extracting")
  return <li className="flex items-start justify-between gap-3">
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <p className="truncate text-xs font-medium" title={name}>{name}</p>
      <p role={working ? "status" : undefined} className="text-xs text-muted-foreground">{lastKnown ? `Last known: ${text}` : text}{!connected && " · offline"}</p>
      {failed && <p role="alert" className="break-words text-xs text-destructive">{status.reason}{status.retryable ? " Silo tries again automatically." : ""}</p>}
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {connected && subscriptionError && <p role="alert" className="break-words text-xs text-destructive">{subscriptionError}</p>}
      {connected && loadError && <p role="alert" className="break-words text-xs text-destructive">{stale ? `Could not refresh: ${loadError}` : loadError}</p>}
    </div>
    <div className="flex shrink-0 gap-1.5">
    {connected && (loadError || subscriptionError) && <Button size="xs" variant="outline" aria-label={`Refresh ChatGPT for Linux status on ${name}`} onClick={() => { void store?.refresh() }}>Refresh</Button>}
    {failed && <Button size="xs" variant="outline" disabled={busy} aria-label={`Retry ChatGPT for Linux on ${name}`} onClick={() => { void store?.retry() }}>Retry</Button>}
    </div>
  </li>
}

function ChatGptAppSettings({ source, active }: { source: ApplicationSource; active: boolean }) {
  if (!useComputerUseBridge()) return null
  return <section aria-label="ChatGPT for Linux" className="grid gap-3">
    <h2 className="text-xs font-medium">ChatGPT for Linux</h2>
    <div className="grid gap-3 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{CHATGPT_DOWNLOAD_NOTE}</p>
      <ul aria-label="ChatGPT for Linux on each computer" className="grid gap-3">
        <ChatGptAppRow name="This computer" active={active} />
        {source.remoteComputers?.map(computer => <ChatGptAppRow key={computer.id} name={computer.name} computer={computer.id} connected={computer.connected} active={active} />)}
      </ul>
    </div>
  </section>
}

export function RemoteComputersSettings({ source, actions, active = true }: { source: ApplicationSource; actions: ApplicationActions; active?: boolean }) {
  return <div className="grid gap-6">
    {actions.connectComputer && <ComputersSection source={source} actions={actions} />}
    <ChatGptAppSettings source={source} active={active} />
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
