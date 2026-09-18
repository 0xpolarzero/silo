import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { Search } from "lucide-react"
import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import type { ApplicationActions, ApplicationWorkspace } from "../model/application-source"
import { formatLog, logIdentity, type LogEntry, type LogPage, type LogQuery } from "../model/logs"

export interface LogWindow { since: string; until: string }
type Result = { workspace: ApplicationWorkspace; page: LogPage; request: LogQuery }
type Row = { entry: LogEntry; workspace: ApplicationWorkspace }
function descending(a: string, b: string): number { return a === b ? 0 : a < b ? 1 : -1 }
function newestFirst(a: Row, b: Row): number {
  return descending(a.entry.occurredAt, b.entry.occurredAt)
    || descending(a.entry.id, b.entry.id)
    || descending(a.entry.computerId, b.entry.computerId)
    || descending(a.entry.sandboxId, b.entry.sandboxId)
}
function chronologicalRows(results: Result[]): Row[] {
  // Keep older rows buffered until every owner's unread history is older too.
  // Otherwise loading a busy owner's next page inserts rows above a quiet owner.
  const frontiers = results.flatMap(({ workspace, page }) => {
    const entry = page.nextCursor ? page.entries.at(-1) : undefined
    return entry ? [{ entry, workspace }] : []
  }).sort(newestFirst)
  const frontier = frontiers[0]
  return results.flatMap(result => result.page.entries.map(entry => ({ entry, workspace: result.workspace })))
    .filter(row => !frontier || newestFirst(row, frontier) <= 0)
    .sort(newestFirst)
}
export function Logs({ workspaces, query, onQueryChange, actions, active, window: initialWindow, onWindowChange }: {
  workspaces: ApplicationWorkspace[]; query: string; onQueryChange: (query: string) => void
  actions: ApplicationActions; active: boolean; window?: LogWindow; onWindowChange?: (window: LogWindow | undefined) => void
}) {
  const [source, setSource] = useState("")
  const [since, setSince] = useState(initialWindow?.since ?? "")
  const [until, setUntil] = useState(initialWindow?.until ?? "")
  const [following, setFollowing] = useState(false)
  const [results, setResults] = useState<Result[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [context, setContext] = useState<{ workspace: ApplicationWorkspace; entry: LogEntry }>()
  const [exportState, setExportState] = useState("")
  const generation = useRef(0)
  const viewport = useRef<HTMLDivElement>(null)
  const getWorkspaces = useEffectEvent(() => workspaces)
  const identity = JSON.stringify(workspaces.map(logIdentity))
  const loader = actions.queryLogs
  const [searchQuery, setSearchQuery] = useState(query)
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(query), loader ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [query, loader])
  const load = useCallback(async (request: LogQuery) => {
    if (!loader) throw new Error("Retained log service unavailable")
    return loader(request)
  }, [loader])
  const invalidRange = Boolean(since && until && since > until)
  useEffect(() => {
    const version = ++generation.current
    if (!active || invalidRange) return
    // Request state is reset when the external query changes.
    // oxlint-disable-next-line react/set-state-in-effect
    setBusy(true); setError(""); setResults([]); setScrollTop(0)
    if (viewport.current) viewport.current.scrollTop = 0
    const selected = context ? [context.workspace] : getWorkspaces()
    const requests = selected.map(workspace => ({ workspace, request: { ...logIdentity(workspace), query: context ? undefined : searchQuery, source: context ? undefined : source || undefined, since: context ? undefined : since || undefined, until: context ? undefined : until || undefined, limit: 200, aroundId: context?.entry.id } }))
    Promise.allSettled(requests.map(async ({ workspace, request }) => ({ workspace, request, page: await load(request) }))).then(value => {
      if (version !== generation.current) return
      setResults(value.flatMap(result => result.status === "fulfilled" ? [result.value] : []))
      setError(value.flatMap((result, index) => result.status === "rejected" ? [`${requests[index].workspace.machine.name}: ${String(result.reason)}`] : []).join("; "))
    }).catch(cause => { if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }).finally(() => { if (version === generation.current) setBusy(false) })
    return () => { generation.current = version + 1 }
  }, [identity, searchQuery, source, since, until, load, active, revision, context, invalidRange])
  useEffect(() => {
    if (!following || !active || context || busy) return
    // Schedule after completion so a slow owner cannot be starved by overlapping scans.
    const timer = window.setTimeout(() => setRevision(value => value + 1), 3000)
    return () => window.clearTimeout(timer)
  }, [following, active, context, busy, revision])
  async function older() {
    const version = generation.current
    setBusy(true); setFollowing(false)
    try {
      const next = await Promise.all(results.map(async result => {
        if (!result.page.nextCursor) return result
        const request = { ...result.request, cursor: result.page.nextCursor }
        const page = await load(request)
        const entries = [...new Map([...result.page.entries, ...page.entries].map(entry => [entry.id, entry])).values()]
        return { ...result, page: { ...page, entries } }
      }))
      if (version === generation.current) setResults(next)
    } catch (cause) { if (version === generation.current) setError(String(cause)) }
    finally { if (version === generation.current) setBusy(false) }
  }
  async function exportMatches() {
    if (!actions.exportLogs) return
    setExportState("Exporting…")
    try { setExportState(await actions.exportLogs(results.map(result => result.request)) ? "Logs saved" : "") }
    catch (cause) { setExportState(`Export failed: ${String(cause)}`) }
  }
  const rows = chronologicalRows(results)
  const total = results.reduce((sum, result) => sum + result.page.totalMatches, 0)
  // Fixed-height rows keep DOM work bounded while full messages remain selectable in context.
  const rowHeight = 52, start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8)
  const visible = rows.slice(start, start + 60)
  const updateTime = (value: string, field: "since" | "until") => {
    const iso = value ? new Date(value).toISOString() : ""
    if (field === "since") setSince(iso); else setUntil(iso)
    onWindowChange?.({ since, until, [field]: iso })
  }
  if (!workspaces.length) return <p>No sandboxes selected. Select at least one sandbox to see its logs.</p>
  return <div className="flex h-full min-h-0 flex-col gap-3">
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input aria-label="Search logs" placeholder="Search logs" value={query} onChange={event => { setContext(undefined); onQueryChange(event.target.value) }} className="h-7 pl-8" /></div>
      <select aria-label="Log source" value={source} onChange={event => { setContext(undefined); setSource(event.target.value) }} className="h-7 rounded border bg-background text-xs"><option value="">All sources</option>{["stdout", "stderr", "output", "system", "runtime", "kernel"].map(value => <option key={value}>{value}</option>)}</select>
      <Button size="xs" variant="outline" aria-pressed={following} onClick={() => setFollowing(value => !value)}>{following ? "Pause" : "Follow"}</Button>
      <CopyButton variant="outline" size="xs" title="Copy the logs in this list" value={rows.map(({ entry }) => formatLog(entry)).join("\n")} disabled={!rows.length || invalidRange} labels={{ idle: "Copy logs", copied: "Logs copied", failed: "Copy logs failed" }} text={{ idle: "Copy", copied: "Copied", failed: "Copy failed" }} />
      {actions.exportLogs && <Button size="xs" variant="outline" title={context ? "Save these logs to a file" : "Save all logs matching your search and filters to a file"} disabled={busy || invalidRange || Boolean(error) || query !== searchQuery || !results.length || exportState === "Exporting…"} onClick={() => void exportMatches()}>Export…</Button>}
      {exportState === "Exporting…" && actions.cancelLogExport && <Button size="xs" variant="outline" onClick={() => void actions.cancelLogExport?.().catch(cause => setExportState(`Cancellation failed: ${String(cause)}`))}>Cancel export</Button>}
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs"><label>From <input aria-label="Logs from" type="datetime-local" value={since ? localTime(since) : ""} onChange={event => { setContext(undefined); updateTime(event.target.value, "since") }} className="rounded border bg-background" /></label><label>To <input aria-label="Logs to" type="datetime-local" value={until ? localTime(until) : ""} onChange={event => { setContext(undefined); updateTime(event.target.value, "until") }} className="rounded border bg-background" /></label>{(since || until) && <Button size="xs" variant="ghost" onClick={() => { setSince(""); setUntil(""); onWindowChange?.(undefined) }}>Clear dates</Button>}</div>
    {invalidRange && <p role="alert">The start must precede the end.</p>}
    {error && <div role="alert" className="text-xs text-destructive">Logs unavailable: {error} <Button size="xs" variant="outline" onClick={() => setRevision(value => value + 1)}>Retry</Button></div>}
    {!invalidRange && (busy || rows.length > 0 || exportState) && <p role="status" className="shrink-0 text-xs text-muted-foreground" title={results.some(result => result.page.timestampEstimated) ? "Some timestamps are estimated from the log file." : undefined}>{busy ? "Loading logs…" : rows.length > 0 ? context ? `Showing ${rows.length} surrounding records.` : `Showing ${rows.length} of ${total} matching records.` : ""} {exportState}</p>}
    {context && <div className="shrink-0 text-xs"><Button size="xs" variant="outline" onClick={() => setContext(undefined)}>Back to search</Button><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">{formatLog(context.entry)}</pre></div>}
    {rows.length > 0 && !invalidRange ? <div role="table" aria-label="Logs" aria-rowcount={rows.length + 1} className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border text-xs">
      <div role="row" className="grid shrink-0 grid-cols-[5.5rem_minmax(0,1fr)_7rem_5rem] gap-3 border-b border-border bg-muted/45 px-3 py-2 font-medium text-muted-foreground"><span role="columnheader">Time</span><span role="columnheader">Message</span><span role="columnheader">Sandbox</span><span role="columnheader" className="sr-only">Actions</span></div>
      <div ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} className="min-h-0 overflow-y-auto overscroll-contain bg-card" data-table-scroll="logs">
        <div style={{ height: start * rowHeight }} aria-hidden="true" />
        {visible.map(({ entry, workspace }, index) => {
          const embedded = /^(\d{2}:\d{2}:\d{2})\s{2,}(.*)$/.exec(entry.line)
          const time = embedded?.[1] ?? new Date(entry.occurredAt).toLocaleTimeString()
          return <div key={`${entry.computerId}:${entry.sandboxId}:${entry.id}`} role="row" aria-rowindex={start + index + 2} style={{ height: rowHeight }} className="group/log-row grid grid-cols-[5.5rem_minmax(0,1fr)_7rem_5rem] items-center gap-3 border-b px-3 py-2 hover:bg-muted/55 focus-within:bg-muted/55">
            <span role="cell" title={entry.occurredAt} className="font-mono text-muted-foreground"><time dateTime={entry.occurredAt}>{time}</time><span className="block text-[10px]">{new Date(entry.occurredAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></span><span role="cell" title={`${entry.source}${entry.session ? ` · session ${entry.session}` : ""}\n${entry.line}`} className="min-w-0 truncate font-mono">{embedded?.[2] ?? entry.line}</span><span role="cell"><WorkspaceBadge name={workspace.machine.name} state={workspace.state} /><span className="block truncate text-[10px] text-muted-foreground">{workspace.computer?.name ?? "This computer"} · {entry.source}</span></span><span role="cell" className="flex"><Button size="icon-xs" variant="ghost" aria-label={`Show surrounding logs for ${entry.id}`} onClick={() => { setFollowing(false); setContext({ workspace, entry }) }}>↔</Button><CopyButton size="icon-xs" variant="ghost" className="opacity-0 group-hover/log-row:opacity-100 group-focus-within/log-row:opacity-100" value={formatLog(entry)} labels={{ idle: `Copy log line from ${workspace.machine.name} at ${time}`, copied: "Log line copied", failed: "Copy log line failed" }} /></span>
          </div>
        })}
        <div style={{ height: Math.max(0, rows.length - start - visible.length) * rowHeight }} aria-hidden="true" />
      </div>
    </div> : !busy && !error && !invalidRange && <p className="text-sm">{query ? "No matching logs." : "No logs in this time range."}</p>}
    {results.some(result => result.page.nextCursor) && <Button className="shrink-0 self-start" size="xs" variant="outline" disabled={busy || invalidRange} onClick={() => void older()}>Load older</Button>}
  </div>
}
function localTime(iso: string): string {
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
