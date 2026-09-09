import { Monitor, Power } from "lucide-react"
import { useRef } from "react"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { SiloMark } from "@/components/silo-mark"
import { Button } from "@/components/ui/button"
import { ListCard, ListRowIcon } from "@/components/list-row"
import { useStatusPanelSize } from "@/desktop/use-status-panel-size"
import { ApplicationShell } from "@/features/application/components/application-shell"
import { ApplicationCommandMenu } from "@/features/application/components/application-command-menu"
import { MachineList } from "@/features/sandboxes/components/machine-list"
import { SandboxListItem, SandboxListRow } from "@/features/sandboxes/components/sandbox-list"
import { useSettings } from "@/features/preferences/settings-store"
import { cn } from "@/lib/utils"

function Skeleton({ className }: { className: string }) {
  const { settings } = useSettings()
  return <span aria-hidden="true" className={cn("inline-block shrink-0 rounded bg-muted align-middle", !settings.reduceMotion && "animate-pulse motion-reduce:animate-none", className)} />
}
function LoadingControls() {
  return <span className="flex gap-0.5" aria-hidden="true">
    <Skeleton className="size-6" /><Skeleton className="size-6" /><Skeleton className="size-6" />
  </span>
}
const unavailable = () => {}

export function ApplicationLoading({ machines, statusPanel = false }: { machines: SetupMachineConfiguration[]; statusPanel?: boolean }) {
  const { settings } = useSettings()
  const content = useRef<HTMLDivElement>(null)
  useStatusPanelSize(content)
  const detail = <span className="flex h-4 items-center"><Skeleton className="h-2.5 w-20" /></span>
  if (statusPanel) return <div ref={content} role="dialog" aria-label="Silo" aria-busy="true" className="silo-window flex max-h-[520px] w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground">
    <span role="status" className="sr-only">Loading sandbox state</span>
    <div className="shrink-0 px-2 pt-2" />
    <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">{machines.length ? <ListCard className="border-0"><ol aria-label="Sandboxes" className="divide-y">
      {machines.map((machine) => <SandboxListItem key={machine.id}><SandboxListRow name={machine.name} kind={machine.kind} detail={detail} actions={<LoadingControls />} /></SandboxListItem>)}
    </ol></ListCard> : <div className="grid justify-items-center gap-1.5 py-8 text-center"><ListRowIcon><Monitor className="size-3.5" /></ListRowIcon><p className="text-[13px] font-medium">No sandboxes yet</p><p className="text-[11px] text-muted-foreground">Add your first sandbox in Silo.</p></div>}</div>
    <footer className="flex shrink-0 items-center justify-between border-t px-2 py-2">
      <Button variant="ghost" size="sm" className="gap-2" disabled><SiloMark data-icon="inline-start" /><span>Open Silo…</span></Button>
      <Button variant="ghost" size="icon-xs" aria-label="Quit Silo" disabled><Power /></Button>
    </footer>
  </div>
  return <ApplicationShell activeTab="workspaces" workspaceSection="overview" settingsSection="general"
    systemIssueStatus={null} workspaceAttention={{ errors: 0, warnings: 0 }} navigationDisabled
    onTabChange={unavailable} onWorkspaceSectionChange={unavailable} onSettingsSectionChange={unavailable}
    canGoBack={false} canGoForward={false} onGoBack={unavailable} onGoForward={unavailable}
    reduceMotion={settings.reduceMotion} commandMenu={<ApplicationCommandMenu commands={[]} disabled />}>
    <div aria-busy="true" className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <span role="status" className="sr-only">Loading sandbox state</span>
      <div className="min-h-0 flex-1">
        <MachineList machines={machines} onMachinesChange={unavailable} interactionDisabled
          getRowPresentation={() => ({ detail, actions: <LoadingControls />, busy: true })} />
      </div>
    </div>
  </ApplicationShell>
}
