import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { ArrowLeft, ChevronRight, Code, Folder, Search } from "lucide-react"

import { ListCard } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ApplicationWorkspace } from "@/features/application/model/application-source"

import { createDirectoryStore, directoryKey, type DirectoryLoader } from "@/features/application/model/directory-store"

export function StatusFolderPicker({ workspace, editor, onBack, onOpen, listDirectory }: {
  listDirectory?: DirectoryLoader
  workspace: ApplicationWorkspace
  editor: string
  onBack: () => void
  onOpen: (path: string) => void
}) {
  const [segments, setSegments] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus() }, [])
  const [store] = useState(() => createDirectoryStore(listDirectory))
  useLayoutEffect(() => { store.setLoader(listDirectory) }, [store, listDirectory])
  const path = ["/workspace", ...segments].join("/")
  const key = directoryKey(workspace.machine.name, path)
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key])
  const snapshot = useSyncExternalStore(subscribe, () => store.getSnapshot(key))
  const available = workspace.machine.kind === "vm" && workspace.state === "running" && workspace.freshness === "fresh"
  useEffect(() => {
    if (!available) { store.invalidateWorkspace(workspace.machine.name); return }
    let focused = true
    const refresh = () => {
      if (focused && document.visibilityState !== "hidden") void store.load(workspace.machine.name, path, { refresh: true })
    }
    const focus = () => { focused = true; refresh() }
    const blur = () => { focused = false }
    refresh()
    const timer = window.setInterval(refresh, 10_000)
    window.addEventListener("focus", focus)
    window.addEventListener("blur", blur)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", focus)
      window.removeEventListener("blur", blur)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [store, available, workspace.machine.name, path])
  const folders = snapshot.entries?.filter((entry) => entry.kind === "folder") ?? []
  const filtered = folders.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase()))
  const unavailable = workspace.machine.kind !== "vm" ? "Remote file browsing is unavailable." : workspace.freshness !== "fresh" ? "Reconnect to browse files." : workspace.state === "stopped" ? "Start this VM to browse its files." : "Files will be available when this VM is running."

  function navigate(next: string[]) {
    setSegments(next)
    setQuery("")
    search.current?.focus()
  }

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <Button ref={back} variant="ghost" size="icon-xs" aria-label="Back to sandboxes" onClick={onBack}><ArrowLeft /></Button>
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-medium">{workspace.machine.name} folders</h2>
          <p className="text-[11px] text-muted-foreground">Choose a folder to open in {editor}</p>
        </div>
      </header>
      <div className="grid min-h-0 flex-auto content-start gap-2 overflow-y-auto p-3">
        <nav aria-label="Folder path" className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-[11px]">
          {["/workspace", ...segments].map((segment, index) => (
            <span key={index} className="flex shrink-0 items-center gap-0.5">
              {index > 0 && <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />}
              <button type="button" className="rounded px-1 py-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-current={index === segments.length ? "location" : undefined} onClick={() => navigate(segments.slice(0, index))}>{segment}</button>
            </span>
          ))}
        </nav>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input ref={search} aria-label="Filter folders" className="pl-8" placeholder="Filter folders…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <ListCard className="max-h-60 overflow-y-auto" aria-busy={available && snapshot.loading || undefined}>
          {!available ? <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">{unavailable}</p> : <>
          {filtered.length > 0 ? <ul aria-label="Folders" className="divide-y">
            {filtered.map((entry) => (
              <li key={entry.name}>
                <button type="button" className="flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => navigate([...segments, entry.name])}>
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul> : snapshot.entries !== null && !snapshot.error && snapshot.nextOffset === null ? <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">{query ? "No matching folders" : "No subfolders here"}</p> : null}
          {((snapshot.entries === null || snapshot.loadingMore) && !snapshot.error) && <div role="status" aria-label="Loading folders" className="grid gap-2 p-3">
            {[60, 45, 70].map((width) => <div key={width} className="h-5 rounded bg-muted motion-safe:animate-pulse" style={{ width: `${width}%` }} />)}
          </div>}
          {snapshot.error && <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span role="alert">{snapshot.entries && snapshot.errorOperation === "refresh" ? "Couldn’t refresh. Showing previous folders." : snapshot.error}</span>
            <Button variant="ghost" size="xs" disabled={snapshot.loading} onClick={() => void store.load(workspace.machine.name, path, snapshot.errorOperation === "more" ? { more: true } : { refresh: true })}>Retry</Button>
          </div>}
          {snapshot.nextOffset !== null && <Button variant="ghost" size="xs" disabled={snapshot.loading} onClick={() => void store.load(workspace.machine.name, path, { more: true })}>Load more</Button>}
          </>}
        </ListCard>
      </div>
      <footer className="flex shrink-0 items-center justify-end border-t px-3 py-2.5">
        <Button variant="outline" size="sm" disabled={!available || snapshot.entries === null || Boolean(snapshot.error)} onClick={() => onOpen(path)}><Code data-icon="inline-start" /> Open in {editor}</Button>
      </footer>
    </>
  )
}
