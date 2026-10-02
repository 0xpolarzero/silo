import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatStorageBytes as formatBytes, type WorkspaceStorageState } from '../model/workspace-storage'
import { HardDrive, Database, Folder, Gauge, RefreshCw, Sparkles, History, ChevronDown, Check, CircleAlert, Clock, Layers, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { dismissOperationToast, errorMessage, showOperationFailure, showOperationProgress, showOperationSuccess } from '@/lib/operation-toast'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'

type ReclaimEntry = WorkspaceStorageState['history'][number]

function date(at: number) { return new Date(at * 1000).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
const reclaimTriggerLabels = new Map([
  ['manual', 'Manual'], ['scheduled', 'Scheduled'], ['beforeStop', 'Before stop'],
  ['afterStart', 'After start'], ['legacy', 'Previous reclaim'],
])
function trigger(value: string) { return reclaimTriggerLabels.get(value) ?? 'Automatic' }

interface StoragePanelProps {
  workspaceId: string
  /** Names the sandbox in the system notification. */
  sandboxName?: string
  running: boolean
  /** The computer that owns the sandbox; omitted for a sandbox on this computer. */
  computerName?: string
  disabled?: boolean
  read: (workspaceId: string) => Promise<WorkspaceStorageState>
  reclaim?: (workspaceId: string) => Promise<WorkspaceStorageState>
}

export function WorkspaceStoragePanel(props: StoragePanelProps) {
  return <WorkspaceStorageContent key={`${props.workspaceId}:${props.running}`} {...props} />
}

function WorkspaceStorageContent({ workspaceId, sandboxName, running, computerName, disabled = false, read, reclaim }: StoragePanelProps) {
  const location = computerName ?? 'This computer'
  const where = computerName ? `on ${computerName}` : 'on this computer'

  const [storage, setStorage] = useState<WorkspaceStorageState | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [reclaiming, setReclaiming] = useState(false)
  const [busy, setBusy] = useState(true)
  const requests = useRef({ generation: 0, busy: true })
  const latestLoad = useRef<((reclaimSpace: boolean) => Promise<void>) | null>(null)
  const readInitial = useEffectEvent(() => {
    const active = requests.current
    const request = ++active.generation
    void read(workspaceId).then(value => {
      if (active.generation === request) setStorage(value)
    }, cause => {
      if (active.generation === request) showOperationFailure(`storage-read:${workspaceId}`, 'Could not read storage', { description: errorMessage(cause), retry: () => void latestLoad.current?.(false), native: false })
    }).finally(() => {
      if (active.generation === request) { active.busy = false; setBusy(false) }
    })
    return () => { active.generation++ }
  })
  useEffect(() => readInitial(), [requests])

  async function load(reclaimSpace: boolean) {
    if (requests.current.busy || disabled || (reclaimSpace && (!running || !reclaim))) return
    requests.current.busy = true
    const request = ++requests.current.generation
    setBusy(true)
    setReclaiming(reclaimSpace)
    const toastId = `storage-reclaim:${workspaceId}`
    const noticeSandbox = sandboxName ? { id: workspaceId, name: sandboxName } : undefined
    if (reclaimSpace) showOperationProgress(toastId, { title: 'Reclaiming unused space', step: 'Your files stay available' })
    try {
      const value = await (reclaimSpace ? reclaim! : read)(workspaceId)
      const current = requests.current.generation === request
      if (current) {
        setStorage(value)
        dismissOperationToast(`storage-read:${workspaceId}`)
      }
      // The operation's notification outlives the panel that started it.
      if (reclaimSpace) {
        if (value.lastError) showOperationFailure(toastId, 'Reclaim failed', { noticeSandbox, description: value.lastError, retry: current ? () => void latestLoad.current?.(true) : undefined })
        else showOperationSuccess(toastId, `Reclaimed ${formatBytes(value.lastReclaimedBytes ?? 0)}`, { description: `Freed ${where}.`, persist: true, noticeSandbox })
      }
    } catch (cause) {
      const current = requests.current.generation === request
      if (reclaimSpace) showOperationFailure(toastId, 'Reclaim failed', { noticeSandbox, description: errorMessage(cause), retry: current ? () => void latestLoad.current?.(true) : undefined })
      if (current) {
        if (!reclaimSpace) showOperationFailure(`storage-read:${workspaceId}`, 'Could not read storage', { description: errorMessage(cause), retry: () => void latestLoad.current?.(false), native: false })
        if (reclaimSpace) {
          try {
            const value = await read(workspaceId)
            if (requests.current.generation === request) setStorage(value)
          } catch { /* Preserve the original operation error if refreshing also fails. */ }
        }
      }
    } finally {
      if (requests.current.generation === request) { requests.current.busy = false; setBusy(false); setReclaiming(false) }
    }
  }

  useLayoutEffect(() => {
    latestLoad.current = load
    return () => { latestLoad.current = null }
  })

  const loading = !storage && busy
  const guest = (value: number | null | undefined) => running && value != null ? formatBytes(value) : 'Unavailable'
  // A disk Silo could not find is unknown, never a misleading 0 B.
  const host = (value: number | null | undefined) => !storage ? '—' : value == null ? 'Unknown' : formatBytes(value)
  const metrics: StorageMetricProps[] = [
    { icon: HardDrive, label: 'Workspace on disk', value: host(storage?.workspaceHostBytes), help: `Space the workspace disk takes ${where}. Deleted files keep using this space until it is reclaimed.` },
    { icon: Database, label: 'Runtime on disk', value: host(storage?.runtimeHostBytes), help: 'The sandbox’s operating system and runtime files. Reclaiming space does not shrink it.' },
    { icon: Folder, label: 'Workspace files', value: guest(storage?.workspaceUsedBytes), help: 'Used inside the sandbox, including filesystem overhead.' },
    { icon: Gauge, label: 'Workspace capacity', value: guest(storage?.workspaceCapacityBytes), help: `The most the workspace can hold. This is a limit, not space used ${where}.` },
  ]
  const checkpointCount = storage?.checkpointCount ?? 0
  const checkpointMetric: StorageMetricProps = {
    icon: Layers,
    label: 'Checkpoints',
    value: host(storage?.checkpointHostBytes),
    help: !storage
      ? loading ? 'Reading saved checkpoint usage…' : 'Refresh storage to check saved checkpoints.'
      : checkpointCount === 0
      ? `No checkpoints are saved ${where}.`
      : `${checkpointCount === 1 ? '1 checkpoint' : `${checkpointCount} checkpoints`} saved ${where}, each counted in full; copies that share blocks can use less. Delete ones you no longer need in Checkpoints.`,
  }

  return <TooltipProvider delayDuration={150}>
    <section aria-label="Sandbox storage" className="@container grid gap-3 text-xs" aria-busy={busy}>
      <div className="flex min-h-6 items-center justify-between">
        <span className="text-muted-foreground">{location}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Refresh storage" disabled={busy || disabled} onClick={() => void load(false)}>
              <RefreshCw className={busy && !reclaiming ? 'animate-spin' : undefined} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh storage measurements</TooltipContent>
        </Tooltip>
      </div>

      <div className="grid grid-cols-2 gap-2 @min-[640px]:grid-cols-4">
        {metrics.map(metric => <StorageMetric key={metric.label} {...metric} loading={loading} />)}
        <StorageMetric {...checkpointMetric} loading={loading} className="col-span-2 @min-[640px]:col-span-4" />
      </div>

      <ReclaimControls
        where={where}
        disabled={busy || disabled || !running || !storage || !reclaim}
        onReclaim={() => void load(true)}
      />
      {!running && <p className="text-muted-foreground">Start the sandbox to measure workspace usage and reclaim unused space.</p>}
      {loading && <div role="status" aria-label="Reading storage" className="sr-only">Reading storage…</div>}
      {storage?.lastError && !reclaiming && <p className="flex items-start gap-2 text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />{storage.lastError}</p>}

      {storage && <ReclaimHistory history={storage.history} open={historyOpen} onOpenChange={setHistoryOpen} />}
    </section>
  </TooltipProvider>
}

interface StorageMetricProps {
  icon: LucideIcon
  label: string
  value: ReactNode
  /** Visible explanation of what the measurement counts. */
  help: string
}

function StorageMetric({ icon: Icon, label, value, help, loading, className }: StorageMetricProps & { loading: boolean; className?: string }) {
  return <div className={`grid content-start gap-1 rounded-md border border-border bg-background/40 p-3 ${className ?? ''}`}>
    <div className="flex items-center gap-2 text-muted-foreground"><Icon aria-hidden="true" className="size-3.5" /><span>{label}</span></div>
    <div className="mt-1 text-lg font-medium tabular-nums tracking-tight">
      {loading ? <span aria-hidden="true" className="inline-block h-6 w-16 animate-pulse rounded bg-muted" /> : value}
    </div>
    <p className="text-[11px] leading-4 text-muted-foreground">{help}</p>
  </div>
}

function ReclaimControls({ where, disabled, onReclaim }: { where: string; disabled: boolean; onReclaim: () => void }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="grid max-w-md gap-0.5 text-[11px] leading-4 text-muted-foreground">
      <span className="flex items-center gap-1.5 font-medium text-foreground"><Clock aria-hidden="true" className="size-3" />Automatic reclamation enabled</span>
      <span>Silo reclaims automatically after 7 days of running, or when the sandbox stops once 24 hours have passed. After a failed attempt it waits 24 hours before trying again.</span>
    </div>
    <div className="grid justify-items-end gap-0.5">
      <Button variant="outline" size="xs" disabled={disabled} onClick={onReclaim}><Sparkles />Reclaim unused space</Button>
      <span className="text-[11px] leading-4 text-muted-foreground">Releases unused blocks {where}. Files and capacity stay the same.</span>
    </div>
  </div>
}

function ReclaimHistory({ history, open, onOpenChange }: { history: ReclaimEntry[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const listId = useId()
  const latest = history[0]
  const summary = latest ? `${latest.error ? 'Failed' : `${formatBytes(latest.reclaimedBytes ?? 0)} freed`} · ${date(latest.at)}` : 'No reclaims yet'
  return <div className="border-t border-border pt-2">
    <button type="button" aria-label={`Reclaim history, ${history.length} ${history.length === 1 ? 'attempt' : 'attempts'}`} aria-expanded={open} aria-controls={listId} onClick={() => onOpenChange(!open)} className="flex w-full items-center gap-2 py-1 text-muted-foreground hover:text-foreground">
      <History aria-hidden="true" className="size-3.5" />
      <span>Reclaim history</span>
      <span className="rounded bg-muted px-1.5 text-[10px]">{history.length}</span>
      <span className="ml-auto text-[11px]">{summary}</span>
      <ChevronDown aria-hidden="true" className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div id={listId} className="mt-2 max-h-56 overflow-y-auto" aria-label="Reclaim history entries">
      {history.length
        ? history.map((entry, index) => <ReclaimHistoryEntry key={`${entry.at}:${index}`} entry={entry} index={index} />)
        : <p className="py-3 text-muted-foreground">Reclaims will appear here. The latest 50 attempts are retained.</p>}
    </div>}
  </div>
}

function ReclaimHistoryEntry({ entry, index }: { entry: ReclaimEntry; index: number }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const title = entry.error ? 'Reclaim did not complete' : entry.reclaimedBytes === 0 ? 'No unused space to reclaim' : `${formatBytes(entry.reclaimedBytes ?? 0)} reclaimed`
  const details = entry.error ?? 'Completed successfully. Unused blocks were released; workspace files and capacity were preserved.'
  return <div className="border-t border-border/50 py-2.5 pr-2">
    <div className="flex items-center gap-2.5">
      {entry.error ? <CircleAlert aria-hidden="true" className="size-3.5 text-destructive" /> : <Check aria-hidden="true" className="size-3.5 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <div>{title}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{trigger(entry.trigger)} · {date(entry.at)}</div>
      </div>
      <button type="button" aria-label={`Details for reclaim ${index + 1}`} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)} className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">Details</button>
    </div>
    {open && <p id={detailsId} className={`mt-1.5 pl-6 text-[11px] leading-4 ${entry.error ? 'text-destructive' : 'text-muted-foreground'}`}>{details}</p>}
  </div>
}
