
import { StatusBadge } from "@/components/status-badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { WorkspaceState } from "@/features/application/model/application-source"
import type { WorkspaceDevice } from "@/features/application/model/connections"

const workspaceStateStyles: Record<WorkspaceState, string> = {
  running: "bg-emerald-500",
  starting: "bg-amber-500",
  stopped: "bg-muted-foreground/55",
  failed: "bg-destructive",
}

// Each state also has its own shape (● running, ▶ starting, ■ stopped, ✕ failed) so the
// state reads without relying on color.
const workspaceStateShapes = {
  running: { shape: "circle", className: "rounded-full" },
  starting: { shape: "triangle", className: "[clip-path:polygon(10%_0,100%_50%,10%_100%)]" },
  stopped: { shape: "square", className: "rounded-[1px]" },
  failed: { shape: "cross", className: "[clip-path:polygon(20%_0,50%_30%,80%_0,100%_20%,70%_50%,100%_80%,80%_100%,50%_70%,20%_100%,0_80%,30%_50%,0_20%)]" },
} as const satisfies Record<WorkspaceState, { shape: string; className: string }>

export function WorkspaceStateDot({ state, className }: { state: WorkspaceState; className?: string }) {
  const { shape, className: shapeClassName } = workspaceStateShapes[state]
  return <span className={cn("size-2", shapeClassName, workspaceStateStyles[state], className)} data-workspace-state-dot={state} data-workspace-state-shape={shape} aria-hidden="true" />
}

export function WorkspaceBadge({ name, state, device }: { name: string; state: WorkspaceState; device?: WorkspaceDevice }) {
  const stateLabel = state.charAt(0).toUpperCase() + state.slice(1)
  return (
    <TooltipProvider delayDuration={150}><Tooltip><TooltipTrigger asChild><StatusBadge
      indicator={<WorkspaceStateDot state={state} />}
      role="group"
      aria-label={`${name}, ${stateLabel}${device ? `, on ${device.name}` : ""}`}
      tabIndex={0}
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {device ? `${name} · ${device.name}` : name}
    </StatusBadge></TooltipTrigger><TooltipContent>{stateLabel} on {device?.name ?? "this device"}</TooltipContent></Tooltip></TooltipProvider>
  )
}

const workspaceStateLabelStyles: Record<WorkspaceState, string> = {
  running: "text-emerald-700 dark:text-emerald-400",
  starting: "text-amber-700 dark:text-amber-400",
  stopped: "text-muted-foreground",
  failed: "text-destructive",
}

export function WorkspaceStateLabel({ state }: { state: WorkspaceState }) {
  return (
    <span className={cn("font-medium", workspaceStateLabelStyles[state])} data-workspace-state={state}>
      {state.charAt(0).toUpperCase() + state.slice(1)}
    </span>
  )
}

export function WorkspaceStatus({ state, detail }: { state: WorkspaceState; detail?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" aria-label={detail ?? state}>
      <WorkspaceStateDot state={state} />
      <WorkspaceStateLabel state={state} />
    </span>
  )
}
