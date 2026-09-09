import { useEffect, useState } from "react"
import { ExternalLink, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CopyButton } from "@/components/copy-button"
import { InlineConfirmation } from "@/components/inline-confirmation"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import type { ApplicationActions, ApplicationWorkspace, NetworkPort, NetworkPortRequest, NetworkState } from "../model/application-source"

function networkAddress(port: NetworkPort) {
  if (port.hostPort === null) return null
  return `${port.scheme ? `${port.scheme}://` : ""}127.0.0.1:${port.hostPort}`
}
const grid = "grid grid-cols-[3.5rem_6rem_minmax(0,1fr)_7rem] items-center gap-2 px-3 py-2 sm:grid-cols-[4rem_minmax(0,1fr)_8rem_7rem_7rem] sm:gap-3"

export function NetworkPage({ workspaces, browser, network, error, actions, active }: {
  workspaces: ApplicationWorkspace[]; browser: string; network?: NetworkState; error?: string | null; actions: ApplicationActions; active: boolean
}) {
  const [draft, setDraft] = useState<{ workspace: string; port: string; hostPort: string; scheme: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const refreshNetwork = actions.refreshNetwork
  useEffect(() => {
    if (!active || !refreshNetwork) return
    const refresh = () => { if (document.visibilityState !== "hidden") void refreshNetwork() }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh) }
  }, [active, refreshNetwork])
  async function run(operation: () => Promise<void>) {
    setBusy(true); setOperationError(null)
    try { await operation(); setConfirm(null); return true }
    catch (cause) { setOperationError(typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "The port could not be updated."); return false }
    finally { setBusy(false) }
  }
  const rows = workspaces.flatMap(workspace => (network?.workspaces.find(item => item.workspace === workspace.machine.name)?.ports ?? []).map(port => ({ workspace, port })))
    .sort((a,b) => a.workspace.machine.name.localeCompare(b.workspace.machine.name) || a.port.port-b.port.port)
  const errors = workspaces.flatMap(workspace => {
    const item = network?.workspaces.find(item => item.workspace === workspace.machine.name)
    return item?.error ? [`${workspace.machine.name}: ${item.error}`] : []
  })
  const localWorkspaces = workspaces.filter(workspace => workspace.machine.kind === "vm")
  const add = (workspace = localWorkspaces[0]?.machine.name ?? "", port = "") => { setOperationError(null); setDraft({ workspace, port, hostPort: "", scheme: "http" }) }
  return <TooltipProvider delayDuration={150}><div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
    <div className="flex justify-end"><Button variant="outline" size="sm" disabled={!actions.saveNetworkPort || !localWorkspaces.length || busy} onClick={() => add()}><Plus />Add port</Button></div>
    {draft && <form className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3" onSubmit={event => {
      event.preventDefault()
      const request: NetworkPortRequest = { workspace: draft.workspace, port: Number(draft.port), hostPort: draft.hostPort ? Number(draft.hostPort) : null, scheme: draft.scheme === "tcp" ? null : draft.scheme as "http" | "https" }
      if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535 || (request.hostPort !== null && (!Number.isInteger(request.hostPort) || request.hostPort < 1 || request.hostPort > 65535))) { setOperationError("Enter a port from 1 to 65535."); return }
      if (actions.saveNetworkPort) void run(() => actions.saveNetworkPort!(request)).then(success => { if (success) setDraft(null) })
    }}>
      <label className="grid gap-1 text-xs text-muted-foreground">Sandbox<select aria-label="Sandbox" className="h-8 rounded-md border border-input bg-background px-2 text-foreground" value={draft.workspace} disabled={busy} onChange={e => setDraft({...draft, workspace: e.target.value})}>{localWorkspaces.map(w => <option key={w.machine.id} value={w.machine.name}>{w.machine.name}</option>)}</select></label>
      <label className="grid gap-1 text-xs text-muted-foreground">VM port<Input aria-label="VM port" className="h-8 w-24" type="number" min={1} max={65535} required autoFocus disabled={busy} value={draft.port} onChange={e => setDraft({...draft, port:e.target.value})} /></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Local port<Input aria-label="Local port" className="h-8 w-24" type="number" min={1} max={65535} placeholder="Automatic" disabled={busy} value={draft.hostPort} onChange={e => setDraft({...draft, hostPort:e.target.value})} /></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Protocol<select aria-label="Protocol" className="h-8 rounded-md border border-input bg-background px-2 text-foreground" disabled={busy} value={draft.scheme} onChange={e => setDraft({...draft, scheme:e.target.value})}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="tcp">TCP</option></select></label>
      <div className="ml-auto flex gap-2"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" size="sm" disabled={busy}>{busy ? "Adding…" : "Add"}</Button></div>
    </form>}
    {(error || errors.length > 0) && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/20 px-3 py-2 text-xs text-destructive"><span>{error || errors.join(" · ")}</span><Button size="sm" variant="ghost" onClick={() => void actions.refreshNetwork?.()}>Retry</Button></div>}
    {operationError && <div role="alert" className="text-xs text-destructive">{operationError}</div>}
    {!network && !error && actions.refreshNetwork ? <div role="status" aria-label="Loading network" className="space-y-2 rounded-lg border border-border p-3">{[0,1,2].map(i => <div key={i} className="h-7 animate-pulse rounded bg-muted motion-reduce:animate-none" />)}</div>
      : rows.length === 0 ? error || errors.length > 0 ? null : <div className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">{workspaces.length === 0 ? "No sandboxes selected" : "No configured ports"}</div>
      : <div className="flex max-h-full min-h-0 self-start w-full flex-col overflow-hidden rounded-lg border border-border"><div role="table" aria-label="Network" className="flex min-h-0 flex-col text-xs">
        <div role="row" className={`${grid} shrink-0 border-b border-border bg-muted/45 font-medium text-muted-foreground`}><span role="columnheader">Port</span><span role="columnheader" className="hidden sm:block">Address</span><span role="columnheader">State</span><span role="columnheader">Sandbox</span><span role="columnheader" className="sr-only">Actions</span></div>
        <div className="min-h-0 divide-y divide-border overflow-y-auto bg-card" data-table-scroll="network">{rows.map(({workspace,port}) => {
          const key = `${workspace.machine.name}:${port.port}`
          const address = networkAddress(port)
          const state = workspace.state !== "running" ? workspace.state === "starting" ? "VM starting" : workspace.state === "failed" ? "VM failed" : "VM stopped" : workspace.freshness === "stale" || error || errors.some(e => e.startsWith(`${workspace.machine.name}:`)) ? "Unknown" : ({reachable:"Reachable",waiting:"Waiting for service",unpublished:"Not exposed",unknown:"Unknown"})[port.state]
          return <div key={key} role="row" className={`${grid} hover:bg-muted/55 focus-within:bg-muted/55`}>
            <span role="cell" className="font-mono font-medium">{port.port}</span><span role="cell" className="hidden min-w-0 font-mono text-muted-foreground sm:block">{address ? <Tooltip><TooltipTrigger asChild><span className="block truncate">{address}</span></TooltipTrigger><TooltipContent>{address}</TooltipContent></Tooltip> : "—"}</span>
            <span role="cell" className={state === "Reachable" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>{state}</span>
            <span role="cell"><WorkspaceBadge name={workspace.machine.name} state={workspace.state} /></span>
            <span role="cell" className="flex justify-end gap-1"><InlineConfirmation active={confirm === key} onDismiss={() => setConfirm(null)}>
              {confirm === key ? <><Button variant="ghost" size="xs" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button><Button variant="destructive" size="xs" disabled={busy} onClick={() => void run(() => actions.removeNetworkPort!(workspace.machine.name,port.port))}>Remove</Button></> : <>
                {address && port.scheme && state === "Reachable" && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Open ${address} in ${browser}`} onClick={() => void run(() => actions.openNetworkPort!(workspace.machine.name,port.port))} disabled={!actions.openNetworkPort}><ExternalLink /></Button></TooltipTrigger><TooltipContent>Open in {browser}</TooltipContent></Tooltip>}
                {address && <Tooltip><TooltipTrigger asChild><CopyButton variant="ghost" size="icon-xs" value={address} labels={{idle:`Copy ${address}`,copied:"Address copied",failed:"Copy failed"}} /></TooltipTrigger><TooltipContent>Copy address</TooltipContent></Tooltip>}
                {port.configured ? <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Remove port ${port.port} from ${workspace.machine.name}`} disabled={busy || !actions.removeNetworkPort} onClick={() => setConfirm(key)}><Trash2 /></Button></TooltipTrigger><TooltipContent>Remove port</TooltipContent></Tooltip> : <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Expose port ${port.port} from ${workspace.machine.name}`} disabled={!actions.saveNetworkPort} onClick={() => add(workspace.machine.name,String(port.port))}><Plus /></Button></TooltipTrigger><TooltipContent>Expose port</TooltipContent></Tooltip>}
              </>}
            </InlineConfirmation></span>
            {port.message && <span role="cell" className={`col-span-full text-xs ${port.state === "unknown" ? "text-destructive" : "text-muted-foreground"}`}>{port.message}</span>}
          </div>
        })}</div>
      </div></div>}
  </div></TooltipProvider>
}
