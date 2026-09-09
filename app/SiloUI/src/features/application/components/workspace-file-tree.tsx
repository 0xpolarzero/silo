import { FolderActions } from "./folder-actions"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { ChevronRight, File, Folder, Link } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { directoryKey, type createDirectoryStore } from "@/features/application/model/directory-store"
import type { ApplicationWorkspace } from "@/features/application/model/application-source"

type DirectoryStore = ReturnType<typeof createDirectoryStore>
const rowClass = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]_.tree-caret]:rotate-90"

function Directory({ workspace, path, label, store, expanded, toggle, onOpenEditor }: {
  workspace: string
  path: string
  label: string
  store: DirectoryStore
  expanded: ReadonlySet<string>
  onOpenEditor?: (workspace: string, path: string) => void
  toggle: (path: string, open: boolean) => void
}) {
  const key = directoryKey(workspace, path)
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key])
  const snapshot = useSyncExternalStore(subscribe, () => store.getSnapshot(key))

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void store.load(workspace, path, { refresh: true })
    }
    refresh()
    const timer = window.setInterval(refresh, 10_000)
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener("focus", refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [store, workspace, path])

  return (
    <ul className="grid gap-0.5 border-l border-border pl-3" aria-label={label} aria-busy={snapshot.loading || undefined}>
      {snapshot.entries?.map((entry) => (
        <li key={entry.path}>
          {entry.kind === "folder" ? <Collapsible open={expanded.has(entry.path)} onOpenChange={(open) => toggle(entry.path, open)}>
            <div className="group/folder flex items-center"><CollapsibleTrigger className={`${rowClass} min-w-0 flex-1`} aria-label={`Folder ${entry.name}`}>
              <ChevronRight className="tree-caret size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none" aria-hidden="true" />
              <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{entry.name}</span>
            </CollapsibleTrigger>
              {onOpenEditor && <FolderActions path={entry.path} onOpen={() => onOpenEditor(workspace, entry.path)} />}
            </div>
            <CollapsibleContent className="ml-4">
              {expanded.has(entry.path) && <Directory workspace={workspace} path={entry.path} label={`${entry.name} contents`} store={store} expanded={expanded} toggle={toggle} onOpenEditor={onOpenEditor} />}
            </CollapsibleContent>
          </Collapsible> : <div className="flex h-8 items-center gap-2 rounded-md px-2 font-mono text-xs" title={entry.kind === "symlink" ? "Symbolic link" : undefined}>
            <span className="size-3.5 shrink-0" aria-hidden="true" />
            {entry.kind === "symlink" ? <Link className="size-4 shrink-0 text-muted-foreground" aria-label="Symbolic link" /> : <File className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="truncate select-text">{entry.name}</span>
          </div>}
        </li>
      ))}
      {((snapshot.entries === null || snapshot.loadingMore) && !snapshot.error) && <li role="status" aria-label="Loading folder" className="grid gap-0.5 py-1">
        {[24, 36, 28].map((width, index) => <div key={index} className="flex h-8 items-center gap-2 px-2 motion-safe:animate-pulse" aria-hidden="true">
          <span className="size-3.5 shrink-0" /><span className="size-4 rounded bg-muted" /><span className="h-3 rounded bg-muted" style={{ width: `${width}%` }} />
        </div>)}
      </li>}
      {snapshot.entries?.length === 0 && !snapshot.error && <li className="px-2 py-1 text-xs text-muted-foreground">Empty folder.</li>}
      {snapshot.error && <li className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span role="alert">{snapshot.errorOperation === "refresh" && snapshot.entries ? "Couldn’t refresh. Showing previous files." : snapshot.error}</span>
        <Button variant="ghost" size="xs" disabled={snapshot.loading} onClick={() => void store.load(workspace, path, snapshot.errorOperation === "more" ? { more: true } : { refresh: true })}>Retry</Button>
      </li>}
      {snapshot.nextOffset !== null && <li><Button variant="ghost" size="xs" disabled={snapshot.loading} onClick={() => void store.load(workspace, path, { more: true })}>Load more</Button></li>}
    </ul>
  )
}

export function WorkspaceFileTree({ workspace, store, active, onOpenEditor }: { onOpenEditor?: (workspace: string, path: string) => void; workspace: ApplicationWorkspace; store: DirectoryStore; active: boolean }) {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const available = workspace.machine.kind === "vm" && workspace.state === "running" && workspace.freshness === "fresh"
  const toggle = (path: string, expand: boolean) => setExpanded((current) => {
    const next = new Set(current)
    if (expand) next.add(path)
    else next.delete(path)
    return next
  })
  return <li><Collapsible open={open} onOpenChange={setOpen}>
    <div className="group/folder flex items-center"><CollapsibleTrigger className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]_.tree-caret]:rotate-90">
      <ChevronRight className="tree-caret size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none" aria-hidden="true" />
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{workspace.machine.name}</span>
    </CollapsibleTrigger>
      {onOpenEditor && <FolderActions path="/workspace" onOpen={() => onOpenEditor(workspace.machine.name, "/workspace")} disabled={!available} />}
    </div>
    <CollapsibleContent className="ml-4">
      {open && (available ? active && <Directory workspace={workspace.machine.name} path="/workspace" label={`Files in ${workspace.machine.name}`} store={store} expanded={expanded} toggle={toggle} onOpenEditor={onOpenEditor} />
        : <p className="border-l border-border py-1 pl-5 text-xs text-muted-foreground">{workspace.machine.kind !== "vm" ? "Remote file browsing is unavailable." : workspace.freshness !== "fresh" ? "Reconnect to browse files." : workspace.state === "stopped" ? "Start this VM to browse its files." : "Files will be available when this VM is running."}</p>)}
    </CollapsibleContent>
  </Collapsible></li>
}
