import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { showActionFailure } from "@/lib/operation-toast"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"

export function ConnectComputerForm({ connect, authorize, setupKey, onClose }: { setupKey?: (address: string) => Promise<void>; authorize?: (address: string) => Promise<void>; connect: (address: string) => Promise<void>; onClose: () => void }) {
  const [address, setAddress] = useState("")
  const [busy, setBusy] = useState(false)
  // Connection failures stay inline: the form is where the user corrects the address, and the
  // SSH recovery actions below only make sense next to the error. Onboarding has no toaster.
  const [error, setError] = useState("")
  async function attempt(action: () => Promise<void>) {
    setBusy(true)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return <form aria-label="Connect computer" className="grid gap-3 rounded-lg border p-3" onSubmit={async event => {
    event.preventDefault()
    if (!address.trim() || busy) return
    setError("")
    await attempt(async () => { await connect(address.trim()); onClose() })
  }}>
    <label className="grid gap-1 text-xs">Computer address<Input technical autoFocus aria-label="Computer address" placeholder="user@computer or SSH alias" value={address} disabled={busy} onChange={event => setAddress(event.target.value)} /></label>
    <p className="text-xs text-muted-foreground">Open Silo on that computer and enable remote management. Uses your existing SSH keys and configuration.</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {error && authorize && <div className="grid justify-items-start gap-1"><Button type="button" variant="outline" size="sm" disabled={busy || !address.trim()} onClick={() => { void attempt(() => authorize(address.trim())) }}>Authorize SSH in Terminal…</Button><p className="text-xs text-muted-foreground">Confirm the computer’s fingerprint and unlock your SSH key, then connect again.</p></div>}
    {error && setupKey && <div className="grid justify-items-start gap-1"><Button type="button" variant="outline" size="sm" disabled={busy || !address.trim()} onClick={() => { void attempt(() => setupKey(address.trim())) }}>Set up Silo SSH key…</Button><p className="text-xs text-muted-foreground">Adds Silo’s public SSH key to your account on the other computer. You may be asked for its password. Then connect again.</p></div>}
    <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" disabled={busy || !address.trim()}>{busy ? "Connecting…" : "Connect"}</Button></div>
  </form>
}

export function RemoteComputersSettings({ source, actions }: { source: ApplicationSource; actions: ApplicationActions }) {
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  async function perform(operation: () => Promise<void>) {
    setBusy(true)
    try { await operation() } catch (cause) { showActionFailure("Computer setting not changed", cause, () => { void perform(operation) }) }
    finally { setBusy(false) }
  }
  if (!actions.connectComputer) return null
  return <section aria-label="Computers" className="grid gap-3">
    <h2 className="text-xs font-medium">Computers</h2>
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-4"><div><label htmlFor="remote-management" className="text-xs font-medium">Allow remote management</label><p className="text-xs text-muted-foreground">Let computers with SSH access to your account manage these VMs while Silo is running.</p><p className="text-xs text-muted-foreground">Quit stops local VMs and disconnects remote sessions.</p></div><Switch id="remote-management" checked={source.remoteManagement?.enabled ?? false} disabled={busy || !source.remoteManagement || !actions.setRemoteManagement} onCheckedChange={enabled => { void perform(() => actions.setRemoteManagement!(enabled)) }} /></div>
      {source.remoteManagement?.enabled && <p className="text-xs text-muted-foreground">SSH access must be enabled here (Remote Login on macOS).</p>}
      {source.remoteManagement?.enabled && <div className="flex items-center justify-between gap-2"><code className="select-text break-all text-xs">{source.remoteManagement.address}</code><Button size="xs" variant="outline" onClick={() => { void perform(async () => { await navigator.clipboard.writeText(source.remoteManagement!.address); setCopied(true) }) }}>{copied ? "Copied" : "Copy address"}</Button></div>}
      {source.remoteComputers?.map(computer => <div key={computer.id} className="flex items-center justify-between gap-3 border-t pt-3"><div className="min-w-0"><p className="truncate text-xs font-medium">{computer.name}</p><p className="text-xs text-muted-foreground">{computer.busy ? "Applying VM changes" : computer.connected ? "Connected" : "Unavailable"} · {computer.address}</p>{computer.error && <p className="text-xs text-destructive">{computer.error}</p>}</div><Button size="xs" variant="ghost" disabled={busy} aria-label={`Remove connection to ${computer.name}`} title="Remove this connection. VMs on that computer are unchanged." onClick={() => { void perform(() => actions.removeComputer!(computer.id)) }}>Remove connection</Button></div>)}
      {!connecting && <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setConnecting(true)}>Connect computer…</Button>}
      {connecting && <ConnectComputerForm connect={actions.connectComputer} authorize={actions.authorizeComputer} setupKey={actions.setupComputerKey} onClose={() => setConnecting(false)} />}
      {source.remoteManagementError && <p role="alert" className="text-xs text-destructive">{source.remoteManagementError}</p>}
    </div>
  </section>
}
