import { ConnectionIcon } from "@/components/connection-icon"
import { ActionsMenu } from "@/components/actions-menu"
import { useSshAccessRefresh } from "./use-ssh-access-refresh"
import { useEffect, useId, useState } from "react"
import { Check, ChevronDown, Download, Pencil, Terminal } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { CopyButton } from "@/components/copy-button"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import { workspaceTarget } from "../model/remote-computers"
import type { ApplicationActions, ApplicationWorkspace, SshAccessRequest, SshAccessState, SshAccessWorkspace } from "../model/application-source"

const statuses = { disabled: "SSH off", waiting: "SSH waiting", listening: "SSH listening", error: "SSH error" }

export function SshAccessPanel({ workspaces, state, error, actions, active }: { workspaces: ApplicationWorkspace[]; state?: SshAccessState; error?: string | null; actions: ApplicationActions; active: boolean }) {
  useSshAccessRefresh(actions.refreshSshAccess, active)
  if (!state && !actions.refreshSshAccess) return null
  return <TooltipProvider delayDuration={150}><section aria-label="SSH access" className="space-y-2 text-xs">
    <h3 className="font-medium">SSH access</h3>
    {error && <div role="alert" className="text-destructive">{error}<Button variant="ghost" size="xs" onClick={() => void actions.refreshSshAccess?.()}>Retry SSH status</Button></div>}
    {workspaces.filter(w => w.machine.kind === "vm").map(workspace => <SshAccessRow key={workspaceTarget(workspace)} workspace={workspace} access={state?.workspaces.find(s => s.workspace === workspaceTarget(workspace))} save={actions.saveSshAccess} connection={actions.sshConnection} stale={Boolean((error && !workspace.computer) || workspace.computer?.connected === false || workspace.freshness === "stale")} />)}
  </section></TooltipProvider>
}

export function SshAccessRow({ workspace, access, save, connection, stale, embedded = false, readOnly = false }: { workspace: ApplicationWorkspace; access?: SshAccessWorkspace; save?: ApplicationActions["saveSshAccess"]; connection?: ApplicationActions["sshConnection"]; stale: boolean; embedded?: boolean; readOnly?: boolean }) {
  stale = stale || Boolean(access?.unavailable)
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 1_200)
    return () => window.clearTimeout(timer)
  }, [copied])
  const [port, setPort] = useState<string | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const external = access?.bindAddress !== "127.0.0.1"
  const blocked = readOnly || busy || !save || stale
  async function change(patch: Partial<SshAccessRequest>) {
    if (!access || !save || blocked) return false
    setBusy(true); setError(null); setCopied(null)
    try {
      await save({ workspace: access.workspace, enabled: access.enabled, port: access.port, bindAddress: access.bindAddress, keys: access.keys, ...patch })
      return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false }
    finally { setBusy(false) }
  }
  async function connect(download: boolean, network: boolean) {
    if (!access || !connection || blocked) return
    setBusy(true); setError(null); setCopied(null)
    try {
      const command = await connection(access.workspace, download, network)
      if (!download && command) { await navigator.clipboard.writeText(command); setCopied(network ? "network" : "local") }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const networkAddresses = access?.addresses.filter(value => value !== "127.0.0.1") ?? []
  const badge = stale ? "SSH status unavailable" : access ? statuses[access.state] : "SSH unavailable"
  const header = <div className="flex items-center gap-3 px-3 py-2">
      <WorkspaceBadge name={workspace.machine.name} state={workspace.state} />
      <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">{badge}{access?.enabled && external ? " · Network" : ""}</span>
      <Tooltip><TooltipTrigger asChild><CollapsibleTrigger asChild><Button variant="ghost" size="icon-xs" className="group ml-auto w-auto gap-0.5 px-1.5 text-[11px]" aria-label={`SSH controls for ${workspace.machine.name}`}>SSH<ChevronDown className="size-2.5 transition-transform group-aria-expanded:rotate-180" /></Button></CollapsibleTrigger></TooltipTrigger><TooltipContent>SSH controls</TooltipContent></Tooltip>
    </div>

  const editor = access && ((port !== null || address !== null) && <form noValidate className="flex flex-wrap items-end gap-2" onSubmit={event => {
            event.preventDefault()
            const value = Number(port ?? access.port)
            if (!Number.isInteger(value) || value < 1 || value > 65535) { setError("Enter a port from 1 to 65535."); return }
            if (address !== null) {
              const octets = address.split(".")
              if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255) || address === "0.0.0.0" || address.startsWith("127.")) { setError("Choose a specific LAN or VPN IPv4 address on the host computer."); return }
            }
            void change({ port: value, ...(address !== null ? { bindAddress: address } : {}) }).then(ok => { if (ok) { setPort(null); setAddress(null) } })
          }}>
            {port !== null && <label className="grid gap-1">Port<Input autoFocus aria-label="SSH port" type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} className="w-24" disabled={blocked} /></label>}
            {address !== null && <label className="grid gap-1">Network address<Input autoFocus={port === null} aria-label="LAN or VPN address" list={`${id}-addresses`} value={address} onChange={event => setAddress(event.target.value)} disabled={blocked} /><datalist id={`${id}-addresses`}>{networkAddresses.map(value => <option key={value} value={value} />)}</datalist></label>}
            <Button type="submit" size="xs" variant="outline" disabled={blocked}>Save</Button><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => { setPort(null); setAddress(null); setError(null) }}>Cancel</Button>
          </form>)

  const content = <>
    <fieldset disabled={readOnly} className="min-w-0 space-y-3 border-0 border-t border-border p-3 text-xs">
      {!access ? <p className="text-muted-foreground">{workspace.computer ? `Waiting for SSH configuration from ${workspace.computer.name}.` : "Waiting for SSH configuration."}</p> : <>
        {(stale || access.state === "error") && <p role="status" className="text-muted-foreground">{access.unavailable || (stale ? "SSH status is unavailable. Reconnect and refresh before changing access." : access.message || "SSH could not start.")}</p>}
        {[false, true].map(network => {
          const host = network ? access.bindAddress : "127.0.0.1"
          const scope = network ? "network" : "local"
          const label = network ? "Allow SSH from other computers" : `Allow SSH from ${access.computerName}`
          return <div key={scope} className="space-y-1" role="group" aria-label={label}>
            <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><ConnectionIcon kind="ssh" network={network} />{label}</span><Switch aria-label={label} checked={network ? external || address !== null : access.enabled} disabled={blocked || (network && !access.enabled)} onCheckedChange={enabled => {
              if (!network) { void change({ enabled }); return }
              if (!enabled) { setAddress(null); if (external) void change({ bindAddress: "127.0.0.1" }) }
              else if (networkAddresses.length === 1) void change({ bindAddress: networkAddresses[0] })
              else setAddress(networkAddresses[0] ?? "")
            }} /></div>
            {access.enabled && (!network || external) && <div className="ssh-endpoint grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 text-muted-foreground">
              <div className="ssh-endpoint-address flex min-w-0 flex-wrap items-center gap-x-3">
                <Tooltip><TooltipTrigger asChild><code tabIndex={0} className="min-w-0 break-all">{host}:{access.port}</code></TooltipTrigger><TooltipContent className="max-w-sm break-all">{access.computerName}{access.fingerprint ? ` · Host key: ${access.fingerprint}` : ""}</TooltipContent></Tooltip>
                <span>User: <code>root</code></span>
              </div>
              <Tooltip><TooltipTrigger asChild><CopyButton variant="ghost" size="icon-xs" value={`${host}:${access.port}`} labels={{ idle: network ? "Copy network SSH address" : "Copy SSH address", copied: "SSH address copied", failed: "Copy failed" }} /></TooltipTrigger><TooltipContent>Copy address</TooltipContent></Tooltip>
              <ActionsMenu label={`More ${scope} SSH actions`} items={[
                { icon: Pencil, label: network ? "Edit address and port" : "Edit port", accessibleLabel: network ? "Edit network connection" : "Edit connection", disabled: blocked, onSelect: () => { setPort(String(access.port)); setAddress(network ? access.bindAddress : null) } },
                { icon: copied === scope ? Check : Terminal, label: copied === scope ? "Command copied" : "Copy terminal command", accessibleLabel: `Copy ${scope} SSH command`, disabled: blocked || !connection || (!network && Boolean(workspace.computer)), onSelect: () => { void connect(false, network) } },
                { label: "Save key file", icon: Download, accessibleLabel: `Save ${scope} SSH key file`, disabled: blocked || !connection, onSelect: () => { void connect(true, network) } },
              ]} />
            </div>}
            {access.enabled && network === (address !== null) && editor}
          </div>
        })}

      </>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </fieldset>
  </>
  return embedded ? <TooltipProvider delayDuration={150}>{content}</TooltipProvider> : <Collapsible className="rounded-lg border border-border bg-card">{header}<CollapsibleContent>{content}</CollapsibleContent></Collapsible>
}


export function SshAccessBadges({ access, stale = false, readOnly = false }: { access?: SshAccessWorkspace; stale?: boolean; readOnly?: boolean }) {
  if (!access?.enabled) return null
  return <TooltipProvider delayDuration={150}>{["127.0.0.1", ...(access.bindAddress !== "127.0.0.1" ? [access.bindAddress] : [])].map(host => {
    const local = host === "127.0.0.1"
    const label = local ? "Local SSH" : "Network SSH"
    return <span key={host} className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${local ? "bg-muted text-muted-foreground" : "bg-blue-500/10 text-blue-700 dark:text-blue-300"}`}>
      <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label={`${label} on ${access.computerName}`} className="inline-flex items-center gap-1"><ConnectionIcon kind="ssh" network={!local} className="mr-1 size-3.5" />SSH</span></TooltipTrigger><TooltipContent>{label} on {access.computerName} · {stale || access.unavailable ? "Status unavailable" : access.state === "listening" ? "Listening" : access.state === "waiting" ? "Waiting for sandbox" : access.message || "Unavailable"} · {host}:{access.port}</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><CopyButton disabled={readOnly} variant="ghost" size="icon-xs" className="size-3.5 rounded-full p-0 [&_svg]:size-2.5" value={`${host}:${access.port}`} labels={{ idle: `Copy ${label} address for ${access.workspace}`, copied: "Address copied", failed: "Copy failed" }} /></TooltipTrigger><TooltipContent>Copy {label} address on {access.computerName}</TooltipContent></Tooltip>
    </span>
  })}</TooltipProvider>
}
