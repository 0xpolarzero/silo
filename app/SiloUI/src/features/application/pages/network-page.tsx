import { workspaceTarget } from "@/features/application/model/remote-computers"
import { useEffect, useId, useState } from "react"
import { Check, ExternalLink, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react"
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
const grid = "grid grid-cols-[3.5rem_6rem_minmax(0,1fr)_7rem] items-center gap-2 px-3 py-2 sm:grid-cols-[6rem_minmax(0,1fr)_8rem_7rem_7rem] sm:gap-3"

export function NetworkPage({ workspaces, browser, network, error, actions, active }: {
  workspaces: ApplicationWorkspace[]; browser: string; network?: NetworkState; error?: string | null; actions: ApplicationActions; active: boolean
}) {
  const [draft, setDraft] = useState<{ workspace: string; port: string; hostPort: string; scheme: string; editing: boolean } | null>(null)
  const fieldID = useId()
  const [fieldErrors, setFieldErrors] = useState<{ port?: string; hostPort?: string }>({})
  const [connecting, setConnecting] = useState<string | null>(null)
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
  const rows = workspaces.flatMap(workspace => (network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))?.ports ?? []).map(port => ({ workspace, port })))
    .sort((a,b) => a.workspace.machine.name.localeCompare(b.workspace.machine.name) || a.port.port-b.port.port)
  const errors = workspaces.flatMap(workspace => {
    const item = network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))
    return item?.error ? [`${workspace.machine.name}: ${item.error}`] : []
  })
  const localWorkspaces = workspaces.filter(workspace => workspace.machine.kind === "vm")
  const add = (workspace = localWorkspaces[0] ? workspaceTarget(localWorkspaces[0]) : "", port = "") => { setOperationError(null); setFieldErrors({}); setDraft({ workspace, port, hostPort: "", scheme: "http", editing: false }) }
  const draftRow = draft && <form noValidate key="port-editor" role="row" aria-label={draft.editing ? "Edit port" : "New port"} className="grid grid-cols-2 items-center gap-2 bg-muted/30 px-3 py-2 sm:grid-cols-[6rem_minmax(0,1fr)_8rem_7rem_7rem] sm:gap-3" onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); setDraft(null); setOperationError(null) } }} onSubmit={event => {
      event.preventDefault()
      const request: NetworkPortRequest = { workspace: draft.workspace, port: Number(draft.port), hostPort: draft.hostPort ? Number(draft.hostPort) : null, scheme: draft.scheme === "tcp" ? null : draft.scheme as "http" | "https" }
      const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535
      const errors = { port: validPort(request.port) ? undefined : "Enter a port from 1 to 65535.", hostPort: request.hostPort === null || validPort(request.hostPort) ? undefined : "Enter a port from 1 to 65535." }
      setFieldErrors(errors)
      if (errors.port || errors.hostPort) return
      if (actions.saveNetworkPort) void run(() => actions.saveNetworkPort!(request)).then(success => { if (success) setDraft(null) })
    }}>
      <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">VM port<Input aria-label="VM port" aria-invalid={Boolean(fieldErrors.port)} aria-describedby={fieldErrors.port ? `${fieldID}-port-error` : undefined} className="h-8 w-full" type="number" min={1} max={65535} required autoFocus={!draft.editing} disabled={busy || draft.editing} value={draft.port} onChange={e => { setDraft({...draft, port:e.target.value}); setFieldErrors(current => ({...current, port: undefined})) }} />{fieldErrors.port && <span id={`${fieldID}-port-error`} className="text-destructive">{fieldErrors.port}</span>}</label></div>
      <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Local port<Input aria-label="Local port" aria-invalid={Boolean(fieldErrors.hostPort)} aria-describedby={fieldErrors.hostPort ? `${fieldID}-hostPort-error` : undefined} className="h-8 w-32 max-w-full" type="number" min={1} max={65535} placeholder="Automatic" autoFocus={draft.editing} disabled={busy} value={draft.hostPort} onChange={e => { setDraft({...draft, hostPort:e.target.value}); setFieldErrors(current => ({...current, hostPort: undefined})) }} />{fieldErrors.hostPort && <span id={`${fieldID}-hostPort-error`} className="text-destructive">{fieldErrors.hostPort}</span>}</label></div>
      <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Protocol<select aria-label="Protocol" className="h-8 rounded-md border border-input bg-background px-2 text-foreground" disabled={busy} value={draft.scheme} onChange={e => setDraft({...draft, scheme:e.target.value})}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="tcp">TCP</option></select></label></div>
      <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Sandbox<select aria-label="Sandbox" className="h-8 min-w-24 rounded-md border border-input bg-background px-2 text-foreground" value={draft.workspace} disabled={busy || draft.editing} onChange={e => setDraft({...draft, workspace: e.target.value})}>{localWorkspaces.map(w => <option key={w.machine.id} value={workspaceTarget(w)}>{w.machine.name}</option>)}</select></label></div>
      <div role="cell" className="flex justify-end gap-1"><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel" disabled={busy} onClick={() => { setDraft(null); setOperationError(null) }}><X /></Button></TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button type="submit" variant="ghost" size="icon-xs" aria-label={draft.editing ? "Save" : "Add"} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}</Button></TooltipTrigger><TooltipContent>{draft.editing ? "Save" : "Add"}</TooltipContent></Tooltip></div>
    </form>
  return <TooltipProvider delayDuration={150}><div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
    <div className="flex h-7 items-center justify-end"><Button variant="outline" size="xs" disabled={!actions.saveNetworkPort || !localWorkspaces.length || busy} onClick={() => add()}><Plus />Add port</Button></div>

    {(error || errors.length > 0) && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/20 px-3 py-2 text-xs text-destructive"><span>{error || errors.join(" · ")}</span><Button size="sm" variant="ghost" onClick={() => void actions.refreshNetwork?.()}>Retry</Button></div>}
    {operationError && <div role="alert" className="text-xs text-destructive">{operationError}</div>}
    {!network && !error && actions.refreshNetwork && !draft ? <div role="status" aria-label="Loading network" className="space-y-2 rounded-lg border border-border p-3">{[0,1,2].map(i => <div key={i} className="h-7 animate-pulse rounded bg-muted motion-reduce:animate-none" />)}</div>
      : rows.length === 0 && !draft ? error || errors.length > 0 ? null : <div className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">{workspaces.length === 0 ? "No sandboxes selected" : "No configured ports"}</div>
      : <div className="flex max-h-full min-h-0 self-start w-full flex-col overflow-hidden rounded-lg border border-border"><div role="table" aria-label="Network" className="flex min-h-0 flex-col text-xs">
        <div role="row" className={`${grid} shrink-0 border-b border-border bg-muted/45 font-medium text-muted-foreground`}><span role="columnheader">Port</span><span role="columnheader" className="hidden sm:block">Address</span><span role="columnheader">State</span><span role="columnheader">Sandbox</span><span role="columnheader" className="sr-only">Actions</span></div>
        <div className="min-h-0 divide-y divide-border overflow-y-auto bg-card" data-table-scroll="network">{draft && !draft.editing && draftRow}{rows.map(({workspace,port}) => {
          const key = `${workspaceTarget(workspace)}:${port.port}`
          if (draft?.editing && draft.workspace === workspaceTarget(workspace) && draft.port === String(port.port)) return draftRow
          const address = networkAddress(port)
          const state = workspace.state !== "running" ? workspace.state === "starting" ? "VM starting" : workspace.state === "failed" ? "VM failed" : "VM stopped" : workspace.freshness === "stale" || error || errors.some(e => e.startsWith(`${workspace.machine.name}:`)) ? "Unknown" : ({reachable:"Reachable",waiting:"Waiting for service",unpublished:"VM only",unknown:"Unknown"})[port.state]
          return <div key={key} role="row" className={`${grid} hover:bg-muted/55 focus-within:bg-muted/55`}>
            <span role="cell" className="font-mono font-medium">{port.port}</span><span role="cell" className="hidden min-w-0 font-mono text-muted-foreground sm:block">{address ? <Tooltip><TooltipTrigger asChild><span className="block truncate">{address}</span></TooltipTrigger><TooltipContent>{address}</TooltipContent></Tooltip> : "—"}</span>
            <span role="cell" className={state === "Reachable" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>{state}</span>
            <span role="cell"><WorkspaceBadge name={workspace.machine.name} state={workspace.state} /></span>
            <span role="cell" className="flex justify-end gap-1"><InlineConfirmation active={confirm === key} onDismiss={() => setConfirm(null)}>
              {confirm === key ? <><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Cancel" disabled={busy} onClick={() => setConfirm(null)}><X /></Button></TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" className="text-destructive" aria-label="Remove" disabled={busy} onClick={() => void run(() => actions.removeNetworkPort!(workspaceTarget(workspace),port.port))}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}</Button></TooltipTrigger><TooltipContent>Confirm removal</TooltipContent></Tooltip></> : <>
                {address && port.scheme && state === "Reachable" && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Open ${address} in ${browser}`} onClick={() => void run(() => actions.openNetworkPort!(workspaceTarget(workspace),port.port))} disabled={!actions.openNetworkPort}><ExternalLink /></Button></TooltipTrigger><TooltipContent>Open in {browser}</TooltipContent></Tooltip>}
                {address && <Tooltip><TooltipTrigger asChild><CopyButton variant="ghost" size="icon-xs" value={address} labels={{idle:`Copy ${address}`,copied:"Address copied",failed:"Copy failed"}} /></TooltipTrigger><TooltipContent>Copy address</TooltipContent></Tooltip>}
                {port.configured && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Edit port ${port.port} from ${workspace.machine.name}`} disabled={busy || !actions.saveNetworkPort} onClick={() => { setOperationError(null); setFieldErrors({}); setDraft({workspace:workspaceTarget(workspace),port:String(port.port),hostPort:port.configuredHostPort == null ? "" : String(port.configuredHostPort),scheme:port.scheme ?? "tcp",editing:true}) }}><Pencil /></Button></TooltipTrigger><TooltipContent>Edit port</TooltipContent></Tooltip>}
                {port.configured ? <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Remove port ${port.port} from ${workspace.machine.name}`} disabled={busy || !actions.removeNetworkPort} onClick={() => { setConfirm(key); setDraft(null) }}><Trash2 /></Button></TooltipTrigger><TooltipContent>Remove port</TooltipContent></Tooltip> : <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Connect port ${port.port} to this computer`} disabled={busy || !actions.saveNetworkPort} onClick={() => { setConnecting(key); void run(() => actions.saveNetworkPort!({workspace:workspaceTarget(workspace),port:port.port,hostPort:null,scheme:"http"})).finally(() => setConnecting(null)) }}>{connecting === key ? <LoaderCircle className="animate-spin" /> : <Plus />}</Button></TooltipTrigger><TooltipContent>Connect to this computer</TooltipContent></Tooltip>}
              </>}
            </InlineConfirmation></span>
            {port.message && <span role="cell" className={`col-span-full text-xs ${port.state === "unknown" ? "text-destructive" : "text-muted-foreground"}`}>{port.message}</span>}
          </div>
        })}</div>
      </div></div>}
  </div></TooltipProvider>
}
