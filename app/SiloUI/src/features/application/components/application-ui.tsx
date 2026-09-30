import type { ReactNode } from "react"
import { AlertTriangle } from "lucide-react"

import { StatusBadge } from "@/components/status-badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { WorkspaceState } from "@/features/application/model/application-source"
import type { WorkspaceComputer } from "@/features/application/model/remote-computers"

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  )
}

export function SectionHeader({ id, title, action }: { id?: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 id={id} className="text-sm font-semibold">{title}</h3>
      {action}
    </div>
  )
}

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

export function WorkspaceBadge({ name, state, computer }: { name: string; state: WorkspaceState; computer?: WorkspaceComputer }) {
  const stateLabel = state.charAt(0).toUpperCase() + state.slice(1)
  return (
    <TooltipProvider delayDuration={150}><Tooltip><TooltipTrigger asChild><StatusBadge
      indicator={<WorkspaceStateDot state={state} />}
      aria-label={`${name}, ${stateLabel}${computer ? `, on ${computer.name}` : ""}`}
      tabIndex={0}
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {computer ? `${name} · ${computer.name}` : name}
    </StatusBadge></TooltipTrigger><TooltipContent>{stateLabel} on {computer?.name ?? "this computer"}</TooltipContent></Tooltip></TooltipProvider>
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

export function InlineNotice({
  title,
  children,
  tone = "warning",
  action,
}: {
  title: string
  children: ReactNode
  tone?: "warning" | "danger"
  action?: ReactNode
}) {
  return (
    <div className={cn(
      "flex items-start gap-3 rounded-lg border p-3 text-sm",
      tone === "danger" ? "border-destructive/25 bg-destructive/8 text-destructive" : "border-amber-500/25 bg-amber-500/8 text-foreground",
    )} role="alert">
      <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", tone === "warning" && "text-amber-600 dark:text-amber-400")} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className={cn("mt-0.5 text-xs", tone === "danger" ? "text-destructive/85" : "text-muted-foreground")}>{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function DetailCard({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <div data-slot="card-action" className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">{action}</div>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
