import { useEffect, useState } from "react"
import { Check, ExternalLink, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CopyButton } from "@/components/copy-button"
import { InlineConfirmation } from "@/components/inline-confirmation"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import type { ApplicationActions, ApplicationWorkspace, NetworkPort, NetworkPortRequest, NetworkState } from "@/features/application/model/application-source"

export function networkAddress(port: NetworkPort) {
  if (port.hostPort === null) return null
  return `${port.scheme ? `${port.scheme}://` : ""}127.0.0.1:${port.hostPort}`
}

/** The human-readable state of a port, accounting for VM lifecycle and stale/failed discovery. */
export function networkPortState(workspace: ApplicationWorkspace, port: NetworkPort, error?: string | null, errors: string[] = []) {
  if (workspace.state !== "running") return workspace.state === "starting" ? "VM starting" : workspace.state === "failed" ? "VM failed" : "VM stopped"
  if (workspace.freshness === "stale" || error || errors.some(e => e.startsWith(`${workspace.machine.name}:`))) return "Unknown"
  return ({ reachable: "Reachable", waiting: "Waiting for service", unpublished: "VM only", unknown: "Unknown" })[port.state]
}

interface PortDraft { workspace: string; port: string; hostPort: string; scheme: string; editing: boolean }

/** Shared state and operations for adding, editing, connecting, and removing forwarded ports.
 * Both the full Network page and a sandbox's Ports section drive identical behaviour from it. */
export function useNetworkPorts({ workspaces, network, error, actions, active }: {
  workspaces: ApplicationWorkspace[]
  network?: NetworkState
  error?: string | null
  actions: ApplicationActions
  active: boolean
}) {
  const [draft, setDraft] = useState<PortDraft | null>(null)
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

  const localWorkspaces = workspaces.filter(workspace => workspace.machine.kind === "vm")
  const rows = workspaces.flatMap(workspace => (network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))?.ports ?? []).map(port => ({ workspace, port })))
    .sort((a, b) => a.workspace.machine.name.localeCompare(b.workspace.machine.name) || a.port.port - b.port.port)
  const errors = workspaces.flatMap(workspace => {
    const item = network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))
    // A stopped sandbox has no live services to observe; its saved ports show as "VM stopped".
    return item?.error && workspace.state !== "stopped" ? [`${workspace.machine.name}: ${item.error}`] : []
  })

  function add(workspace = localWorkspaces[0] ? workspaceTarget(localWorkspaces[0]) : "", port = "") {
    setOperationError(null); setFieldErrors({}); setDraft({ workspace, port, hostPort: "", scheme: "http", editing: false })
  }
  function startEdit(workspace: ApplicationWorkspace, port: NetworkPort) {
    setOperationError(null); setFieldErrors({})
    setDraft({ workspace: workspaceTarget(workspace), port: String(port.port), hostPort: port.configuredHostPort == null ? "" : String(port.configuredHostPort), scheme: port.scheme ?? "tcp", editing: true })
  }
  function cancelDraft() { setDraft(null); setOperationError(null) }

  return {
    error, draft, setDraft, fieldErrors, setFieldErrors, connecting, setConnecting, busy, operationError, confirm, setConfirm,
    run, add, startEdit, cancelDraft, localWorkspaces, rows, errors, actions,
  }
}

export type NetworkPortsController = ReturnType<typeof useNetworkPorts>

/** The add/edit port form, rendered as a table row on the Network page or inline in a section.
 * When `hideSandbox` is set the workspace is fixed and its selector is omitted. */
export function NetworkPortForm({ controller, fieldID, hideSandbox = false, className }: {
  controller: NetworkPortsController
  fieldID: string
  hideSandbox?: boolean
  className?: string
}) {
  const { draft, setDraft, fieldErrors, setFieldErrors, busy, localWorkspaces, actions, run } = controller
  if (!draft) return null
  const gridClassName = className ?? "grid grid-cols-2 items-center gap-2 bg-muted/30 px-3 py-2 sm:grid-cols-[6rem_minmax(0,1fr)_8rem_7rem_7rem] sm:gap-3"
  return <form noValidate key="port-editor" role="row" aria-label={draft.editing ? "Edit port" : "New port"} className={gridClassName} onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); controller.cancelDraft() } }} onSubmit={event => {
    event.preventDefault()
    const request: NetworkPortRequest = { workspace: draft.workspace, port: Number(draft.port), hostPort: draft.hostPort ? Number(draft.hostPort) : null, scheme: draft.scheme === "tcp" ? null : draft.scheme as "http" | "https" }
    const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535
    const errors = { port: validPort(request.port) ? undefined : "Enter a port from 1 to 65535.", hostPort: request.hostPort === null || validPort(request.hostPort) ? undefined : "Enter a port from 1 to 65535." }
    setFieldErrors(errors)
    if (errors.port || errors.hostPort) return
    if (actions.saveNetworkPort) void run(() => actions.saveNetworkPort!(request)).then(success => { if (success) setDraft(null) })
  }}>
    <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">VM port<Input aria-label="VM port" aria-invalid={Boolean(fieldErrors.port)} aria-describedby={fieldErrors.port ? `${fieldID}-port-error` : undefined} className="h-8 w-full" type="number" min={1} max={65535} required autoFocus={!draft.editing} disabled={busy || draft.editing} value={draft.port} onChange={e => { setDraft({ ...draft, port: e.target.value }); setFieldErrors(current => ({ ...current, port: undefined })) }} />{fieldErrors.port && <span id={`${fieldID}-port-error`} className="text-destructive">{fieldErrors.port}</span>}</label></div>
    <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Local port<Input aria-label="Local port" aria-invalid={Boolean(fieldErrors.hostPort)} aria-describedby={fieldErrors.hostPort ? `${fieldID}-hostPort-error` : undefined} className="h-8 w-32 max-w-full" type="number" min={1} max={65535} placeholder="Automatic" autoFocus={draft.editing} disabled={busy} value={draft.hostPort} onChange={e => { setDraft({ ...draft, hostPort: e.target.value }); setFieldErrors(current => ({ ...current, hostPort: undefined })) }} />{fieldErrors.hostPort && <span id={`${fieldID}-hostPort-error`} className="text-destructive">{fieldErrors.hostPort}</span>}</label></div>
    <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Protocol<select aria-label="Protocol" className="h-8 rounded-md border border-input bg-background px-2 text-foreground" disabled={busy} value={draft.scheme} onChange={e => setDraft({ ...draft, scheme: e.target.value })}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="tcp">TCP</option></select></label></div>
    {hideSandbox
      ? <input type="hidden" value={draft.workspace} readOnly />
      : <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Sandbox<select aria-label="Sandbox" className="h-8 min-w-24 rounded-md border border-input bg-background px-2 text-foreground" value={draft.workspace} disabled={busy || draft.editing} onChange={e => setDraft({ ...draft, workspace: e.target.value })}>{localWorkspaces.map(w => <option key={w.machine.id} value={workspaceTarget(w)}>{w.machine.name}</option>)}</select></label></div>}
    <div role="cell" className="flex justify-end gap-1"><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel" disabled={busy} onClick={() => controller.cancelDraft()}><X /></Button></TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button type="submit" variant="ghost" size="icon-xs" aria-label={draft.editing ? "Save" : "Add"} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}</Button></TooltipTrigger><TooltipContent>{draft.editing ? "Save" : "Add"}</TooltipContent></Tooltip></div>
  </form>
}

/** The per-port action cluster (Open/Copy/Edit/Remove/Connect) with inline removal confirmation,
 * shared so the Network page and a sandbox's Ports section apply identical behaviour. */
export function NetworkPortRowActions({ controller, workspace, port, state, browser }: {
  controller: NetworkPortsController
  workspace: ApplicationWorkspace
  port: NetworkPort
  state: string
  browser: string
}) {
  const { actions, busy, confirm, setConfirm, setDraft, connecting, setConnecting, run } = controller
  const key = `${workspaceTarget(workspace)}:${port.port}`
  const address = networkAddress(port)
  return <InlineConfirmation active={confirm === key} onDismiss={() => setConfirm(null)}>
    {confirm === key ? <><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Cancel" disabled={busy} onClick={() => setConfirm(null)}><X /></Button></TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" className="text-destructive" aria-label="Remove" disabled={busy} onClick={() => void run(() => actions.removeNetworkPort!(workspaceTarget(workspace), port.port))}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}</Button></TooltipTrigger><TooltipContent>Confirm removal</TooltipContent></Tooltip></> : <>
      {address && port.scheme && state === "Reachable" && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Open ${address} in ${browser}`} onClick={() => void run(() => actions.openNetworkPort!(workspaceTarget(workspace), port.port))} disabled={!actions.openNetworkPort}><ExternalLink /></Button></TooltipTrigger><TooltipContent>Open in {browser}</TooltipContent></Tooltip>}
      {address && <Tooltip><TooltipTrigger asChild><CopyButton variant="ghost" size="icon-xs" value={address} labels={{ idle: `Copy ${address}`, copied: "Address copied", failed: "Copy failed" }} /></TooltipTrigger><TooltipContent>Copy address</TooltipContent></Tooltip>}
      {port.configured && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Edit port ${port.port} from ${workspace.machine.name}`} disabled={busy || !actions.saveNetworkPort} onClick={() => controller.startEdit(workspace, port)}><Pencil /></Button></TooltipTrigger><TooltipContent>Edit port</TooltipContent></Tooltip>}
      {port.configured ? <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Remove port ${port.port} from ${workspace.machine.name}`} disabled={busy || !actions.removeNetworkPort} onClick={() => { setConfirm(key); setDraft(null) }}><Trash2 /></Button></TooltipTrigger><TooltipContent>Remove port</TooltipContent></Tooltip> : <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Connect port ${port.port} to this computer`} disabled={busy || !actions.saveNetworkPort} onClick={() => { setConnecting(key); void run(() => actions.saveNetworkPort!({ workspace: workspaceTarget(workspace), port: port.port, hostPort: null, scheme: "http" })).finally(() => setConnecting(null)) }}>{connecting === key ? <LoaderCircle className="animate-spin" /> : <Plus />}</Button></TooltipTrigger><TooltipContent>Connect to this computer</TooltipContent></Tooltip>}
    </>}
  </InlineConfirmation>
}
