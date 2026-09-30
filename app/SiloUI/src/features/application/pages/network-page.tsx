import { workspaceTarget } from "@/features/application/model/remote-computers"
import { useId } from "react"
import { Network, Plus } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import { NetworkPortForm, NetworkPortRowActions } from "@/features/application/components/network-ports"
import { networkAddress, networkPortState, useNetworkPorts } from "@/features/application/components/network-ports-state"
import type { ApplicationActions, ApplicationWorkspace, NetworkState } from "../model/application-source"

const grid = "grid grid-cols-[3.5rem_6rem_minmax(0,1fr)_8.5rem] items-center gap-2 px-3 py-2 sm:grid-cols-[6rem_minmax(0,1fr)_8rem_7rem_8.5rem] sm:gap-3"

export function NetworkPage({ workspaces, browser, network, error, actions, active }: {
  workspaces: ApplicationWorkspace[]; browser: string; network?: NetworkState; error?: string | null; actions: ApplicationActions; active: boolean
}) {
  const fieldID = useId()
  const controller = useNetworkPorts({ workspaces, network, error, actions, active })
  const { draft, rows, errors, addDisabledReason, runningLocalWorkspaces, busy } = controller
  const draftRow = <NetworkPortForm controller={controller} fieldID={fieldID} />

  return <TooltipProvider delayDuration={150}><div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
    <div className="flex h-7 items-center justify-end">{addDisabledReason
      ? <Tooltip><TooltipTrigger asChild><span tabIndex={0}><Button variant="outline" size="xs" disabled><Plus />Add port</Button></span></TooltipTrigger><TooltipContent>{addDisabledReason}</TooltipContent></Tooltip>
      : <Button variant="outline" size="xs" disabled={!actions.saveNetworkPort || !runningLocalWorkspaces.length || busy} onClick={() => controller.add()}><Plus />Add port</Button>}</div>

    {(error || errors.length > 0) && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/20 px-3 py-2 text-xs text-destructive"><span>{error || errors.join(" · ")}</span><Button size="sm" variant="ghost" onClick={() => void actions.refreshNetwork?.()}>Retry</Button></div>}
    {!network && !error && actions.refreshNetwork && !draft ? <div role="status" aria-label="Loading network" className="space-y-2 rounded-lg border border-border p-3">{[0, 1, 2].map(i => <div key={i} className="h-7 animate-pulse rounded bg-muted motion-reduce:animate-none" />)}</div>
      : rows.length === 0 && !draft ? error || errors.length > 0 ? null : <EmptyState icon={<Network />} title={workspaces.length === 0 ? "No matching sandboxes" : "No configured ports"} />
      : <div className="flex max-h-full min-h-0 self-start w-full flex-col overflow-hidden rounded-lg border border-border"><div role="table" aria-label="Network" className="flex min-h-0 flex-col text-xs">
        <div role="row" className={`${grid} shrink-0 border-b border-border bg-muted/45 font-medium text-muted-foreground`}><span role="columnheader">Port</span><span role="columnheader" className="hidden sm:block">Address</span><span role="columnheader">State</span><span role="columnheader">Sandbox</span><span role="columnheader" className="sr-only">Actions</span></div>
        <div className="min-h-0 divide-y divide-border overflow-y-auto bg-card" data-table-scroll="network">{draft && !draft.editing && draftRow}{rows.map(({ workspace, port, host }) => {
          const key = `${workspaceTarget(workspace)}:${port.port}`
          if (draft?.editing && draft.workspace === workspaceTarget(workspace) && draft.port === String(port.port)) return <NetworkPortForm key={key} controller={controller} fieldID={fieldID} />
          const address = networkAddress(port, host)
          const state = networkPortState(workspace, port, error, errors)
          return <div key={key} role="row" className={`${grid} hover:bg-muted/55 focus-within:bg-muted/55`}>
            <span role="cell" className="font-mono font-medium">{port.port}</span><span role="cell" className="hidden min-w-0 font-mono text-muted-foreground sm:block">{address ? <Tooltip><TooltipTrigger asChild><span className="block truncate">{address}</span></TooltipTrigger><TooltipContent>{address}</TooltipContent></Tooltip> : "—"}</span>
            <span role="cell" className={state === "Reachable" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>{state}</span>
            <span role="cell"><WorkspaceBadge name={workspace.machine.name} state={workspace.state} computer={workspace.computer} /></span>
            <span role="cell" className="flex justify-end gap-1"><NetworkPortRowActions controller={controller} workspace={workspace} port={port} state={state} browser={browser} host={host} /></span>
            {port.message && workspace.state === "running" && <span role="cell" className={`col-span-full text-xs ${port.state === "unknown" ? "text-destructive" : "text-muted-foreground"}`}>{port.message}</span>}
          </div>
        })}</div>
      </div></div>}
  </div></TooltipProvider>
}
