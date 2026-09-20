import { useEffect, useEffectEvent, useRef, useState, type ReactElement } from 'react'
import type { WorkspaceStorageState } from '../model/workspace-storage'
import { HardDrive, Database, Folder, Gauge, RefreshCw, Sparkles, History, ChevronDown, Check, CircleAlert, Loader2, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ListRowIcon } from '@/components/list-row'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'

function Tip({ text, children }: { text: string; children: ReactElement }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent className="max-w-64">{text}</TooltipContent></Tooltip>
}
function date(at: number) { return new Date(at * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function trigger(value: string) { return ({ manual: 'Manual', scheduled: 'Scheduled', beforeStop: 'Before stop', afterStart: 'After start', legacy: 'Previous reclaim' } as Record<string, string>)[value] ?? 'Automatic' }
function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B"
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

interface StoragePanelProps {
  workspaceId: string
  running: boolean
  disabled?: boolean
  read: (workspaceId: string) => Promise<WorkspaceStorageState>
  reclaim?: (workspaceId: string) => Promise<WorkspaceStorageState>
}

export function WorkspaceStoragePanel(props: StoragePanelProps) {
  return <WorkspaceStorageContent key={`${props.workspaceId}:${props.running}`} {...props} />
}

function WorkspaceStorageContent({ workspaceId, running, disabled = false, read, reclaim }: StoragePanelProps) {
  const [storage, setStorage] = useState<WorkspaceStorageState | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [reclaiming, setReclaiming] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const requests = useRef({ generation: 0 })
  const readInitial = useEffectEvent(() => read(workspaceId))
  useEffect(() => {
    const active = requests.current
    const request = ++active.generation
    void readInitial().then(value => {
      if (active.generation === request) setStorage(value)
    }, cause => {
      if (active.generation === request) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (active.generation === request) setBusy(false)
    })
    return () => { active.generation++ }
  }, [requests])

  async function load(reclaimSpace: boolean) {
    if (busy || disabled || (reclaimSpace && (!running || !reclaim))) return
    const request = ++requests.current.generation
    setBusy(true)
    setReclaiming(reclaimSpace)
    setError(null)
    setResult(null)
    try {
      const value = await (reclaimSpace ? reclaim! : read)(workspaceId)
      if (requests.current.generation !== request) return
      setStorage(value)
      if (reclaimSpace && !value.lastError && value.lastReclaimedBytes !== null) {
        setResult(`Reclaimed ${formatBytes(value.lastReclaimedBytes)} on this computer.`)
      }
    } catch (cause) {
      if (requests.current.generation === request) {
        setError(cause instanceof Error ? cause.message : String(cause))
        if (reclaimSpace) {
          try {
            const value = await read(workspaceId)
            if (requests.current.generation === request) setStorage(value)
          } catch { /* Preserve the original operation error if refreshing also fails. */ }
        }
      }
    } finally {
      if (requests.current.generation === request) { setBusy(false); setReclaiming(false) }
    }
  }

  const history = storage?.history ?? []
 const cards=[{icon:HardDrive,label:'Workspace on disk',value:storage ? formatBytes(storage.workspaceHostBytes) : '—',tip:'Physical space occupied by the workspace disk on this computer. Deleted guest files can still occupy space here until a reclaim.'},{icon:Database,label:'Runtime on disk',value:storage ? formatBytes(storage.runtimeHostBytes) : '—',tip:'Physical space used by the sandbox’s operating system and runtime. Workspace reclamation does not reduce this disk.'},{icon:Folder,label:'Workspace files',value:running && storage?.workspaceUsedBytes != null ? formatBytes(storage.workspaceUsedBytes) : 'Unavailable',tip:'Space reported as used by the workspace filesystem inside the running sandbox, including filesystem metadata.'},{icon:Gauge,label:'Workspace capacity',value:running && storage?.workspaceCapacityBytes != null ? formatBytes(storage.workspaceCapacityBytes) : 'Unavailable',tip:'Usable filesystem capacity inside the sandbox. This is a limit, not space currently occupied on this computer.'}]
 return <TooltipProvider delayDuration={150}><section aria-label="Sandbox storage" className="@container border-t border-border p-3 text-xs space-y-3" aria-busy={busy}>
 <div className="flex items-center justify-between"><span className="font-medium">Storage <span className="text-muted-foreground font-normal">· This computer</span></span><Tip text={'Refresh storage measurements'}><Button variant="ghost" size="icon-xs" aria-label="Refresh storage" disabled={busy || disabled} onClick={()=>void load(false)}><RefreshCw className={busy && !reclaiming ? "animate-spin" : undefined}/></Button></Tip></div>
 <div className="grid grid-cols-2 gap-2 @min-[640px]:grid-cols-4">{cards.map(c=><Tip key={c.label} text={c.tip}><div tabIndex={0} className="rounded-md border border-border bg-background/40 p-3"><div className="flex items-center gap-2 text-muted-foreground"><c.icon className="size-3.5"/><span>{c.label}</span></div><div className="mt-2 text-lg font-medium tabular-nums tracking-tight">{c.value}</div></div></Tip>)}</div>
 <div className="flex flex-wrap items-center justify-between gap-3"><Tip text="Unused workspace blocks are released without deleting your files. Automatic reclaims run after 7 days while running, or before a normal stop after 24 hours. Failed attempts wait 24 hours before retrying automatically."><span tabIndex={0} className="text-muted-foreground flex items-center gap-1.5 cursor-help"><Clock className="size-3"/>Automatic reclamation enabled</span></Tip><Tip text="Release unused workspace disk space on this computer. Your files and workspace capacity stay the same."><Button variant="outline" size="xs" disabled={busy || disabled || !running || !storage || !reclaim} onClick={()=>void load(true)}><Sparkles/>Reclaim unused space</Button></Tip></div>
 {reclaiming&&<div role="status" className="flex gap-2.5 rounded-md bg-muted/40 p-2.5"><ListRowIcon><Loader2 className="size-3.5 animate-spin"/></ListRowIcon><div className="flex-1 space-y-2"><div className="flex justify-between"><span>Reclaiming unused space…</span></div><Progress value={null} aria-label="Reclaim progress"/><p className="text-muted-foreground text-[11px]">Releasing unused workspace blocks. Your files stay available.</p></div></div>}
 {!running && <p className="text-muted-foreground">Start the sandbox to measure workspace usage and reclaim unused space.</p>}
 {!storage && busy && <p role="status">Reading storage…</p>}
 {(error || storage?.lastError) && <div role="alert" className="flex items-start gap-2 text-destructive"><CircleAlert className="mt-0.5 size-3.5 shrink-0"/><p>{error || storage?.lastError}</p></div>}
 {result && <span role="status" className="sr-only">{result}</span>}
 <div className="border-t border-border pt-2"><button aria-label={`Reclaim history, ${history.length} attempts`} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="flex w-full items-center gap-2 py-1 text-muted-foreground hover:text-foreground"><History className="size-3.5"/><span>Reclaim history</span><span className="text-[10px] rounded bg-muted px-1.5">{history.length}</span><span className="ml-auto text-[11px]">{history.length?`${history[0].error?'Failed':formatBytes(history[0].reclaimedBytes ?? 0)+' freed'} · ${date(history[0].at)}`:'No reclaims yet'}</span><ChevronDown className={`size-3 transition-transform ${expanded?'rotate-180':''}`}/></button>
 {expanded&&<div className="mt-2 max-h-56 overflow-y-auto" aria-label="Reclaim history entries">{history.length?history.map((h,index)=><div key={`${h.at}:${index}`} className="flex items-center gap-2.5 border-t border-border/50 py-2.5 pr-2">{h.error?<CircleAlert className="size-3.5 text-destructive"/>:<Check className="size-3.5 text-muted-foreground"/>}<div className="min-w-0 flex-1"><div>{h.error?'Reclaim did not complete':h.reclaimedBytes===0?'No unused space to reclaim':formatBytes(h.reclaimedBytes ?? 0)+' reclaimed'}</div><div className="mt-0.5 text-[11px] text-muted-foreground">{trigger(h.trigger)} · {date(h.at)}</div></div><Tip text={h.error ? h.error:'Completed successfully. Unused blocks were released; workspace files and capacity were preserved.'}><button aria-label={`Details for reclaim ${index + 1}`} className="text-muted-foreground text-[11px] underline decoration-dotted underline-offset-4">Details</button></Tip></div>):<p className="py-3 text-muted-foreground">Reclaims will appear here. The latest 50 attempts are retained.</p>}</div>}</div>
 </section></TooltipProvider>
}
