import { Binary, Check, ExternalLink, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CopyButton } from "@/components/copy-button"
import { ConfirmPopover } from "@/components/confirm-popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import type { ApplicationWorkspace, NetworkPort, NetworkPortRequest } from "@/features/application/model/application-source"
import { networkAddress, networkLoopbackAddress, type NetworkPortsController } from "./network-ports-state"

/** "this Mac" on macOS, otherwise "this computer". */
const thisComputer = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "this Mac" : "this computer"


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
  const gridClassName = className ?? "grid grid-cols-2 items-center gap-2 bg-muted/30 px-3 py-2 sm:grid-cols-[6rem_minmax(0,1fr)_8rem_7rem_8.5rem] sm:gap-3"
  return <form noValidate key="port-editor" role="row" aria-label={draft.editing ? "Edit port" : "New port"} className={gridClassName} onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); controller.cancelDraft() } }} onSubmit={event => {
    event.preventDefault()
    const request: NetworkPortRequest = { workspace: draft.workspace, port: Number(draft.port), hostPort: draft.hostPort ? Number(draft.hostPort) : null, scheme: draft.scheme === "tcp" ? null : draft.scheme as "http" | "https" }
    const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535
    const errors = { port: validPort(request.port) ? undefined : "Enter a port from 1 to 65535.", hostPort: request.hostPort === null || validPort(request.hostPort) ? undefined : "Enter a port from 1 to 65535." }
    setFieldErrors(errors)
    if (errors.port || errors.hostPort) return
    if (actions.saveNetworkPort) {
      const verb = draft.editing ? "edit" : "add"
      void run(`network-port:${draft.workspace}:${request.port}:${verb}`, draft.editing
        ? { loading: `Saving port ${request.port}`, step: `Saving port ${request.port} on ${draft.workspace}`, success: `Port ${request.port} saved`, failure: `Could not save port ${request.port}` }
        : { loading: `Adding port ${request.port}`, step: `Publishing port ${request.port} on ${draft.workspace}`, success: `Port ${request.port} added`, failure: `Could not add port ${request.port}` }, () => actions.saveNetworkPort!(request), () => setDraft(null))
    }
  }}>
    <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Port<Input technical aria-label="Port" aria-invalid={Boolean(fieldErrors.port)} aria-describedby={fieldErrors.port ? `${fieldID}-port-error` : undefined} className="h-8 w-full" type="number" min={1} max={65535} required autoFocus={!draft.editing} disabled={busy || draft.editing} value={draft.port} onChange={e => { setDraft({ ...draft, port: e.target.value }); setFieldErrors(current => ({ ...current, port: undefined })) }} />{fieldErrors.port && <span id={`${fieldID}-port-error`} className="text-destructive">{fieldErrors.port}</span>}</label></div>
    <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Local port<Input technical aria-label="Local port" aria-invalid={Boolean(fieldErrors.hostPort)} aria-describedby={fieldErrors.hostPort ? `${fieldID}-hostPort-error` : undefined} className="h-8 w-32 max-w-full" type="number" min={1} max={65535} placeholder="Automatic" autoFocus={draft.editing} disabled={busy} value={draft.hostPort} onChange={e => { setDraft({ ...draft, hostPort: e.target.value }); setFieldErrors(current => ({ ...current, hostPort: undefined })) }} />{fieldErrors.hostPort && <span id={`${fieldID}-hostPort-error`} className="text-destructive">{fieldErrors.hostPort}</span>}</label></div>
    <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Protocol<select aria-label="Protocol" className="h-8 rounded-md border border-input bg-background px-2 text-foreground" disabled={busy} value={draft.scheme} onChange={e => setDraft({ ...draft, scheme: e.target.value })}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="tcp">TCP</option></select></label></div>
    {hideSandbox
      ? <input type="hidden" value={draft.workspace} readOnly />
      : <div role="cell"><label className="grid gap-1 text-xs text-muted-foreground">Sandbox<select aria-label="Sandbox" className="h-8 min-w-24 rounded-md border border-input bg-background px-2 text-foreground" value={draft.workspace} disabled={busy || draft.editing} onChange={e => setDraft({ ...draft, workspace: e.target.value })}>{localWorkspaces.filter(w => w.state === "running" || workspaceTarget(w) === draft.workspace).map(w => <option key={w.machine.id} value={workspaceTarget(w)}>{w.machine.name}{w.computer ? ` · ${w.computer.name}` : ""}{w.state === "running" ? "" : " (stopped)"}</option>)}</select></label></div>}
    <div role="cell" className="flex justify-end gap-1"><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel" disabled={busy} onClick={() => controller.cancelDraft()}><X /></Button></TooltipTrigger><TooltipContent>Cancel</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button type="submit" variant="ghost" size="icon-xs" aria-label={draft.editing ? "Save" : "Add"} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}</Button></TooltipTrigger><TooltipContent>{draft.editing ? "Save" : "Add"}</TooltipContent></Tooltip></div>
  </form>
}

/** The per-port action cluster (Open/Copy/Edit/Remove/Connect) with inline removal confirmation,
 * shared so the Network page and a sandbox's Ports section apply identical behaviour. */
export function NetworkPortRowActions({ controller, workspace, port, state, host }: {
  controller: NetworkPortsController
  workspace: ApplicationWorkspace
  port: NetworkPort
  state: string
  browser: string
  /** The sandbox's website host name, when websites open at one instead of 127.0.0.1. */
  host?: string | null
}) {
  const { actions, busy, setDraft, connecting, setConnecting, run, open } = controller
  const key = `${workspaceTarget(workspace)}:${port.port}`
  const address = networkAddress(port, host)
  const loopback = networkLoopbackAddress(port)
  return <>
      {address && port.scheme && state === "Reachable" && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Open port ${port.port} in browser`} onClick={() => void open(workspaceTarget(workspace), port.port)} disabled={!actions.openNetworkPort}><ExternalLink /></Button></TooltipTrigger><TooltipContent>Open in browser</TooltipContent></Tooltip>}
      {address && <Tooltip><TooltipTrigger asChild><CopyButton variant="ghost" size="icon-xs" value={address} labels={{ idle: `Copy ${address}`, copied: "Address copied", failed: "Copy failed" }} /></TooltipTrigger><TooltipContent>Copy address</TooltipContent></Tooltip>}
      {loopback && address !== loopback && <Tooltip><TooltipTrigger asChild><CopyButton variant="ghost" size="icon-xs" icon={Binary} value={loopback} labels={{ idle: `Copy ${loopback}`, copied: "Address copied", failed: "Copy failed" }} /></TooltipTrigger><TooltipContent><span className="block font-medium">Copy 127.0.0.1 address</span><span className="block">For development servers that reject other host names</span></TooltipContent></Tooltip>}
      {port.configured && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Edit port ${port.port} from ${workspace.machine.name}`} disabled={busy || !actions.saveNetworkPort} onClick={() => controller.startEdit(workspace, port)}><Pencil /></Button></TooltipTrigger><TooltipContent>Edit port</TooltipContent></Tooltip>}
      {port.configured ? <ConfirmPopover tooltip="Remove port" align="end" tone="destructive" title={`Remove port ${port.port}?`} description={`It stops forwarding to ${thisComputer}.`} confirmLabel="Remove" onConfirm={() => { setDraft(null); return run(`network-port:${key}:remove`, { loading: `Removing port ${port.port}`, step: `Removing port ${port.port} from ${workspace.machine.name}`, success: `Port ${port.port} removed`, failure: `Could not remove port ${port.port}` }, () => actions.removeNetworkPort!(workspaceTarget(workspace), port.port)).then(() => undefined) }}><Button variant="ghost" size="icon-xs" aria-label={`Remove port ${port.port} from ${workspace.machine.name}`} disabled={busy || !actions.removeNetworkPort}><Trash2 /></Button></ConfirmPopover> : <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Forward port ${port.port} to ${thisComputer}`} disabled={busy || !actions.saveNetworkPort} onClick={() => { setConnecting(key); void run(`network-port:${key}:add`, { loading: `Forwarding port ${port.port}`, step: `Publishing port ${port.port} on ${workspace.machine.name}`, success: `Port ${port.port} forwarded`, failure: `Could not forward port ${port.port}` }, () => actions.saveNetworkPort!({ workspace: workspaceTarget(workspace), port: port.port, hostPort: null, scheme: "http" })).finally(() => setConnecting(null)) }}>{connecting === key ? <LoaderCircle className="animate-spin" /> : <Plus />}</Button></TooltipTrigger><TooltipContent><span className="block font-medium">Forward to {thisComputer}</span><span className="block">Make this port reachable from this computer</span></TooltipContent></Tooltip>}
  </>
}
