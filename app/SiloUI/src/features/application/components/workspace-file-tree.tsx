import { workspaceTarget } from "@/features/application/model/connections"
import { visibleText } from "@/lib/visible-text"
import { FolderActions } from "./folder-actions"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ChevronRight, File, Folder, Link } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { directoryKey, type createDirectoryStore } from "@/features/application/model/directory-store"
import type { ApplicationWorkspace } from "@/features/application/model/application-source"

type DirectoryStore = ReturnType<typeof createDirectoryStore>
/** Adds a shown folder to its tree's refresh set; returns the removal. */
type RegisterDirectory = (path: string) => () => void
const rowClass = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]_.tree-caret]:rotate-90"
const refreshInterval = 10_000

function Directory({ workspace, path, label, store, expanded, toggle, register, editor, onOpenEditor }: {
  workspace: string
  path: string
  label: string
  store: DirectoryStore
  expanded: ReadonlySet<string>
  editor: string
  onOpenEditor?: (workspace: string, path: string) => void
  toggle: (path: string, open: boolean) => void
  register: RegisterDirectory
}) {
  const key = directoryKey(workspace, path)
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key])
  const snapshot = useSyncExternalStore(subscribe, () => store.getSnapshot(key))

  // Refresh once when shown; the tree's root keeps every shown folder current from then on.
  useEffect(() => {
    if (document.visibilityState !== "hidden") void store.load(workspace, path, { refresh: true })
    return register(path)
  }, [store, workspace, path, register])

  return (
    <ul className="grid gap-0.5 border-l border-border pl-3" aria-label={label} aria-busy={snapshot.loading || undefined}>
      {snapshot.entries?.map((entry) => (
        <li key={entry.path}>
          {entry.kind === "folder" ? <Collapsible open={expanded.has(entry.path)} onOpenChange={(open) => toggle(entry.path, open)}>
            <div className="group/folder flex items-center rounded-md pr-1 hover:bg-muted focus-within:bg-muted"><CollapsibleTrigger className={`${rowClass} min-w-0 flex-1`} aria-label={`Folder ${visibleText(entry.name)}`}>
              <ChevronRight className="tree-caret size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none" aria-hidden="true" />
              <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate" title={visibleText(entry.name)}>{visibleText(entry.name)}</span>
            </CollapsibleTrigger>
              {onOpenEditor && <FolderActions editor={editor} path={entry.path} onOpen={() => onOpenEditor(workspace, entry.path)} />}
            </div>
            <CollapsibleContent className="ml-4">
              {expanded.has(entry.path) && <Directory editor={editor} workspace={workspace} path={entry.path} label={`${visibleText(entry.name)} contents`} store={store} expanded={expanded} toggle={toggle} register={register} onOpenEditor={onOpenEditor} />}
            </CollapsibleContent>
          </Collapsible> : <div className="flex h-8 items-center gap-2 rounded-md px-2 font-mono text-xs" title={entry.kind === "symlink" ? "Symbolic link" : undefined}>
            <span className="size-3.5 shrink-0" aria-hidden="true" />
            {entry.kind === "symlink" ? <Link className="size-4 shrink-0 text-muted-foreground" aria-label="Symbolic link" /> : <File className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="truncate select-text" title={visibleText(entry.name)}>{visibleText(entry.name)}</span>
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
        <span role="alert">{snapshot.errorOperation === "refresh" && snapshot.entries ? "Could not refresh. Showing previous files." : snapshot.error}</span>
        <Button variant="ghost" size="xs" disabled={snapshot.loading} onClick={() => void store.load(workspace, path, snapshot.errorOperation === "more" ? { more: true } : { refresh: true })}>Retry</Button>
      </li>}
      {snapshot.nextOffset !== null && <li><Button variant="ghost" size="xs" disabled={snapshot.loading} onClick={() => void store.load(workspace, path, { more: true })}>Load more</Button></li>}
    </ul>
  )
}

/**
 * `active` is whether the page showing this tree is visible. While the page, the tree and the
 * window are all visible, one timer and one pair of focus listeners at the root refresh every
 * folder currently shown; collapsed folders and hidden pages are never polled.
 */
export function WorkspaceFileTree({ workspace, store, active, editor, onOpenEditor }: { editor: string; onOpenEditor?: (workspace: string, path: string) => void; workspace: ApplicationWorkspace; store: DirectoryStore; active: boolean }) {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const available = workspace.state === "running" && workspace.freshness === "fresh"
  const target = workspaceTarget(workspace)
  const toggle = (path: string, expand: boolean) => setExpanded((current) => {
    const next = new Set(current)
    if (expand) next.add(path)
    else next.delete(path)
    return next
  })
  const shown = useRef(new Set<string>())
  const register = useCallback<RegisterDirectory>((path) => {
    shown.current.add(path)
    return () => { shown.current.delete(path) }
  }, [])
  const polling = open && available && active
  useEffect(() => {
    if (!polling) return
    let disposed = false
    const failures = new Map<string, { delay: number; nextRead: number }>()
    const refresh = (force = false) => {
      if (disposed || document.visibilityState === "hidden") return
      for (const path of failures.keys()) if (!shown.current.has(path)) failures.delete(path)
      for (const path of shown.current) {
        const key = directoryKey(target, path)
        const snapshot = store.getSnapshot(key)
        if (!snapshot.error) failures.delete(path)
        if (snapshot.loading || (!force && (failures.get(path)?.nextRead ?? 0) > Date.now())) continue
        void store.load(target, path, { refresh: true }).then(() => {
          if (disposed) return
          if (!store.getSnapshot(key).error) failures.delete(path)
          else {
            const delay = Math.min((failures.get(path)?.delay ?? refreshInterval) * 2, 60000)
            failures.set(path, { delay, nextRead: Date.now() + delay })
          }
        })
      }
    }
    const timer = window.setInterval(refresh, refreshInterval)
    const onReturn = () => refresh(true)
    document.addEventListener("visibilitychange", onReturn)
    window.addEventListener("focus", onReturn)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onReturn)
      window.removeEventListener("focus", onReturn)
    }
  }, [polling, store, target])
  return <li><Collapsible open={open} onOpenChange={setOpen}>
    <div className="group/folder flex items-center rounded-md pr-1 hover:bg-muted focus-within:bg-muted"><CollapsibleTrigger className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]_.tree-caret]:rotate-90">
      <ChevronRight className="tree-caret size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none" aria-hidden="true" />
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate" title={workspace.machine.name}>{workspace.machine.name}</span>
    </CollapsibleTrigger>
      {onOpenEditor && <FolderActions editor={editor} path="/workspace" onOpen={() => onOpenEditor(target, "/workspace")} disabled={!available} />}
    </div>
    <CollapsibleContent className="ml-4">
      {open && (available ? active && <Directory editor={editor} workspace={target} path="/workspace" label={`Files in ${workspace.machine.name}`} store={store} expanded={expanded} toggle={toggle} register={register} onOpenEditor={onOpenEditor} />
        : <p className="border-l border-border py-1 pl-5 text-xs text-muted-foreground">{workspace.freshness !== "fresh" ? "Reconnect to browse files." : workspace.state === "stopped" ? "Start this sandbox to browse its files." : "Files will be available when this sandbox is running."}</p>)}
    </CollapsibleContent>
  </Collapsible></li>
}
