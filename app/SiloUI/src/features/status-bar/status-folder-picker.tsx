import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ChevronRight, Code, Folder, Search } from "lucide-react"

import { ListCard } from "@/components/list-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ApplicationFileEntry, ApplicationWorkspace } from "@/features/application/model/application-source"

export function StatusFolderPicker({ workspace, editor, onBack, onOpen }: {
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
  let entries: ApplicationFileEntry[] = workspace.files
  for (const segment of segments) entries = entries.find((entry) => entry.name === segment)?.children ?? []
  const folders = entries.filter((entry) => entry.kind === "folder")
  const filtered = folders.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase()))
  const path = ["/workspace", ...segments].join("/")

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
        <ListCard className="max-h-60 overflow-y-auto">
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
          </ul> : <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">{query ? "No matching folders" : "No subfolders here"}</p>}
        </ListCard>
      </div>
      <footer className="flex shrink-0 items-center justify-end border-t px-3 py-2.5">
        <Button variant="outline" size="sm" onClick={() => onOpen(path)}><Code data-icon="inline-start" /> Open in {editor}</Button>
      </footer>
    </>
  )
}
