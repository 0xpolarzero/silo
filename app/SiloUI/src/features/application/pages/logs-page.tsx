import { useEffect, useMemo, useState } from "react"
import { RefreshCw, Search, ScrollText } from "lucide-react"
import { LogFilters } from "../components/log-filters"
import { LogsTable } from "../components/logs-table"
import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ApplicationActions, ApplicationWorkspace } from "../model/application-source"
import { formatLog } from "../model/logs"
import { useLogHistory } from "../model/use-log-history"
import { dismissOperationToast, errorMessage, showActionFailure, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"

export interface LogWindow { since: string; until: string }
export function Logs({ workspaces, query, onQueryChange, actions, active, window: initialWindow, onWindowChange }: {
  workspaces: ApplicationWorkspace[]; query: string; onQueryChange: (query: string) => void
  actions: ApplicationActions; active: boolean; window?: LogWindow; onWindowChange?: (window: LogWindow | undefined) => void
}) {
  const [source, setSource] = useState("")
  const [since, setSince] = useState(initialWindow?.since ?? "")
  const [until, setUntil] = useState(initialWindow?.until ?? "")
  const [following, setFollowing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const loader = actions.queryLogs
  const [searchQuery, setSearchQuery] = useState(query)
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(query), loader ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [query, loader])
  const invalidRange = Boolean(since && until && since > until)
  const { results, rows, unsupportedNotice, busy, loadingOlder, error, ready, hasOlder, refresh, retry, loadOlder, scrollTop, setScrollTop, expandedRows, setExpandedRows } = useLogHistory({ workspaces, loader, active, query: searchQuery, source, since, until, invalidRange })
  useEffect(() => {
    if (!following || !active || busy || invalidRange || error) return
    // Schedule after completion so a slow owner cannot be starved by overlapping scans.
    const timer = window.setTimeout(() => void refresh(), 3000)
    return () => window.clearTimeout(timer)
  }, [following, active, busy, invalidRange, error, refresh])
  async function exportMatches() {
    if (!actions.exportLogs) return
    const id = "logs-export"
    setExporting(true)
    showOperationProgress(id, {
      title: "Exporting logs…",
      cancel: actions.cancelLogExport ? { onCancel: () => void actions.cancelLogExport?.().catch(cause => showActionFailure("Cancellation failed", cause)) } : undefined,
    })
    try {
      if (await actions.exportLogs(results.map(result => result.request))) showOperationSuccess(id, "Logs saved")
      else dismissOperationToast(id)
    } catch (cause) {
      showOperationFailure(id, "Export failed", { description: errorMessage(cause), retry: () => void exportMatches() })
    } finally { setExporting(false) }
  }
  const total = results.reduce((sum, result) => sum + result.page.totalMatches, 0)
  const copiedLogs = useMemo(() => rows.map(({ entry }) => formatLog(entry)).join("\n"), [rows])
  if (!workspaces.length) return <p>No sandboxes selected. Select at least one sandbox to see its logs.</p>
  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input technical aria-label="Search logs" placeholder="Search logs" value={query} onChange={event => onQueryChange(event.target.value)} className="h-7 pl-8" /></div>
      <Button size="icon-xs" variant="outline" aria-label="Refresh logs" title="Refresh logs" disabled={busy || invalidRange || query !== searchQuery} onClick={() => void refresh()}><RefreshCw aria-hidden="true" className={busy && ready && !loadingOlder ? "motion-safe:animate-spin" : undefined} /></Button>
      <Button size="xs" variant="outline" aria-pressed={following} onClick={() => setFollowing(value => !value)}>{following ? "Pause" : "Follow"}</Button>
      <CopyButton variant="outline" size="xs" title="Copy the logs in this list" value={copiedLogs} disabled={!rows.length || invalidRange} labels={{ idle: "Copy logs", copied: "Logs copied", failed: "Copy logs failed" }} text={{ idle: "Copy", copied: "Copied", failed: "Copy failed" }} />
      {actions.exportLogs && <Button size="xs" variant="outline" title="Save all logs matching your search and filters to a file" disabled={busy || invalidRange || Boolean(error) || query !== searchQuery || !results.length || exporting} onClick={() => void exportMatches()}>Export…</Button>}
    </div>
    <LogFilters source={source} since={since} until={until} onChange={filters => {
      setSource(filters.source); setSince(filters.since); setUntil(filters.until)
      onWindowChange?.(filters.since || filters.until ? { since: filters.since, until: filters.until } : undefined)
    }} />
    {invalidRange && <p role="alert">The start must precede the end.</p>}
    {error && <div role="alert" className="text-xs text-destructive">Logs unavailable: {error} <Button size="xs" variant="outline" disabled={busy} onClick={() => void retry()}>Retry</Button></div>}
    {unsupportedNotice && <p role="status" className="text-xs text-muted-foreground">{unsupportedNotice}</p>}
    {!invalidRange && <p role="status" className="min-h-4 shrink-0 text-xs text-muted-foreground" title={results.some(result => result.page.timestampEstimated) ? "Some timestamps are estimated from the log file." : undefined}>{rows.length > 0 ? `Showing ${rows.length} of ${total} matching records.` : ""}</p>}
    {!invalidRange && (rows.length > 0 || !ready && !error) ? <LogsTable
      rows={rows}
      loading={!ready}
      loadingOlder={loadingOlder}
      hasOlder={hasOlder && !busy && !error}
      active={active && !following}
      scrollTop={scrollTop}
      onScrollTopChange={setScrollTop}
      expandedRows={expandedRows}
      onExpandedRowsChange={setExpandedRows}
      onLoadOlder={() => void loadOlder()}
    /> : !busy && !error && !invalidRange && <div className="grid min-h-48 place-items-center rounded-lg border border-dashed border-border px-6 text-center">
      <div><ScrollText aria-hidden="true" className="mx-auto mb-3 size-5 text-muted-foreground" /><p className="text-sm font-medium">{query || source || since || until ? "No results" : "No logs yet"}</p></div>
    </div>}
  </div>
}
