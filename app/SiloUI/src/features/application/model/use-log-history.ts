import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import type { ApplicationWorkspace } from "./application-source"
import { logIdentity, type LogEntry, type LogLoader, type LogPage, type LogQuery } from "./logs"

export type LogHistoryRow = { entry: LogEntry; workspace: ApplicationWorkspace }
export type LogHistoryResult = { workspace: ApplicationWorkspace; page: LogPage; request: LogQuery }
type CachedResult = LogHistoryResult & { cursors: Set<string> }
type Options = {
  workspaces: ApplicationWorkspace[]
  loader?: LogLoader
  active: boolean
  query: string
  source: string
  since: string
  until: string
  invalidRange: boolean
}
type Snapshot = {
  results: CachedResult[]
  busy: boolean
  loadingOlder: boolean
  ready: boolean
  error: string
  scrollTop: number
  expandedRows: ReadonlyMap<string, number>
}

// Backend snapshots expire after 30 minutes. Inactive views expire sooner and
// share a bounded LRU. The currently displayed history stays available to scroll.
const CACHE_TTL = 10 * 60 * 1000
const MAX_CACHED_VIEWS = 8
const MAX_CACHED_BYTES = 8 * 1024 * 1024
const caches = new WeakMap<LogLoader, Map<string, HistoryStore>>()
const unavailable: LogLoader = async () => { throw new Error("Retained log service unavailable") }
function ownerKey(workspace: ApplicationWorkspace): string {
  const identity = logIdentity(workspace)
  return JSON.stringify([identity.computerId ?? "local", identity.sandboxId])
}
function entryKey(entry: LogEntry): string {
  return JSON.stringify([entry.computerId, entry.sandboxId, entry.id])
}
function descending(a: string, b: string): number { return a === b ? 0 : a < b ? 1 : -1 }
function newestFirst(a: LogHistoryRow, b: LogHistoryRow): number {
  return descending(a.entry.occurredAt, b.entry.occurredAt)
    || descending(a.entry.id, b.entry.id)
    || descending(a.entry.computerId, b.entry.computerId)
    || descending(a.entry.sandboxId, b.entry.sandboxId)
}
function chronologicalRows(results: LogHistoryResult[]): LogHistoryRow[] {
  // Buffer older rows until every owner's unread history is older as well, so
  // paging a busy owner cannot insert records above a quiet owner's visible rows.
  const frontiers = results.flatMap(({ workspace, page }) => {
    const entry = page.nextCursor ? page.entries.at(-1) : undefined
    return entry ? [{ entry, workspace }] : []
  }).sort(newestFirst)
  const frontier = frontiers[0]
  return results.flatMap(({ workspace, page }) => page.entries.map(entry => ({ entry, workspace })))
    .filter(row => !frontier || newestFirst(row, frontier) <= 0)
    .sort(newestFirst)
}
function prune(cache: Map<string, HistoryStore>) {
  const now = Date.now()
  for (const [key, store] of cache) {
    if (!store.observed && !store.inFlight && now - store.lastRequestAt >= CACHE_TTL) cache.delete(key)
  }
  const inactive = [...cache.entries()].filter(([, store]) => !store.observed && !store.inFlight)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
  let bytes = inactive.reduce((sum, [, store]) => sum + store.bytes, 0)
  let count = inactive.length
  for (const [key, store] of inactive) {
    if (count <= MAX_CACHED_VIEWS && bytes <= MAX_CACHED_BYTES) break
    cache.delete(key)
    bytes -= store.bytes
    count--
  }
}
class HistoryStore {
  private cache: Map<string, HistoryStore>
  private loader: LogLoader
  private requests: { workspace: ApplicationWorkspace; request: LogQuery }[]
  private snapshot: Snapshot = { results: [], busy: false, loadingOlder: false, ready: false, error: "", scrollTop: 0, expandedRows: new Map() }
  private listeners = new Set<() => void>()
  private errors = new Map<string, string>()
  private failedPaging = new Set<string>()
  private stalled = false
  inFlight: Promise<void> | undefined
  lastRequestAt = Date.now()
  lastUsedAt = Date.now()
  bytes = 0

  constructor(cache: Map<string, HistoryStore>, loader: LogLoader, requests: { workspace: ApplicationWorkspace; request: LogQuery }[]) {
    this.cache = cache
    this.loader = loader
    this.requests = requests
  }

  get observed() { return this.listeners.size > 0 }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.lastUsedAt = Date.now()
    this.listeners.add(listener)
    return () => { this.lastUsedAt = Date.now(); this.listeners.delete(listener); prune(this.cache) }
  }
  private update(change: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }
  private errorMessage() { return [...this.errors.values()].join("; ") }
  private measure() {
    this.bytes = this.snapshot.results.reduce((sum, result) => sum + result.page.entries.reduce((size, entry) => size + 256 + 2 * (entry.line.length + entry.id.length + entry.occurredAt.length + entry.source.length + (entry.session?.length ?? 0)), 0), 0)
  }
  setScrollTop = (scrollTop: number) => {
    if (scrollTop !== this.snapshot.scrollTop) this.update({ scrollTop })
  }
  setExpandedRows = (update: (current: ReadonlyMap<string, number>) => ReadonlyMap<string, number>) => {
    const expandedRows = update(this.snapshot.expandedRows)
    if (expandedRows !== this.snapshot.expandedRows) this.update({ expandedRows })
  }
  refresh = (): Promise<void> => {
    if (this.inFlight) return this.inFlight
    this.update({ busy: true, loadingOlder: false })
    this.inFlight = this.fetchFirst().finally(() => this.finish())
    return this.inFlight
  }
  private async fetchFirst() {
    const settled = await Promise.allSettled(this.requests.map(async ({ workspace, request }): Promise<CachedResult> => ({ workspace, request, page: await this.loader(request), cursors: new Set() })))
    const previous = new Map(this.snapshot.results.map(result => [ownerKey(result.workspace), result]))
    const results: CachedResult[] = []
    this.errors.clear()
    this.failedPaging.clear()
    this.stalled = false
    for (const [index, value] of settled.entries()) {
      const { workspace } = this.requests[index]
      const key = ownerKey(workspace)
      if (value.status === "fulfilled") results.push(value.value)
      else {
        const retained = previous.get(key)
        if (retained) results.push(retained)
        this.errors.set(key, `${workspace.machine.name}: ${String(value.reason)}`)
      }
    }
    this.update({ results, ready: true, error: this.errorMessage(), ...(settled.some(value => value.status === "fulfilled") && { scrollTop: 0 }) })
  }
  loadOlder = (): Promise<void> => this.pageOlder()
  retry = (): Promise<void> => this.failedPaging.size && !this.stalled ? this.pageOlder(this.failedPaging) : this.refresh()
  private pageOlder(onlyOwners?: Set<string>): Promise<void> {
    if (this.inFlight) return this.inFlight
    const requested = this.snapshot.results.filter(result => result.page.nextCursor && (!onlyOwners || onlyOwners.has(ownerKey(result.workspace))))
    if (!requested.length) return Promise.resolve()
    this.update({ busy: true, loadingOlder: true })
    this.inFlight = this.fetchOlder(requested).finally(() => this.finish())
    return this.inFlight
  }
  private async fetchOlder(requested: CachedResult[]) {
    const settled = await Promise.allSettled(requested.map(async result => this.loader({ ...result.request, cursor: result.page.nextCursor! })))
    const updates = new Map<string, CachedResult>()
    for (const [index, value] of settled.entries()) {
      const result = requested[index]
      const key = ownerKey(result.workspace)
      if (value.status === "rejected") {
        this.errors.set(key, `${result.workspace.machine.name}: ${String(value.reason)}`)
        this.failedPaging.add(key)
        continue
      }
      this.errors.delete(key)
      this.failedPaging.delete(key)
      const page = value.value
      const cursors = new Set(result.cursors).add(result.page.nextCursor!)
      const merged = new Map(result.page.entries.map(entry => [entryKey(entry), entry]))
      for (const entry of page.entries) merged.set(entryKey(entry), entry)
      const didNotAdvance = Boolean(page.nextCursor && (cursors.has(page.nextCursor) || merged.size === result.page.entries.length))
      if (didNotAdvance) {
        this.errors.set(key, `${result.workspace.machine.name}: Log history did not advance. Refresh to continue.`)
        this.stalled = true
      }
      const entries = [...merged.values()].sort((a, b) => newestFirst({ entry: a, workspace: result.workspace }, { entry: b, workspace: result.workspace }))
      updates.set(key, { ...result, cursors, page: { ...page, entries, nextCursor: didNotAdvance ? null : page.nextCursor } })
    }
    this.update({ results: this.snapshot.results.map(result => updates.get(ownerKey(result.workspace)) ?? result), error: this.errorMessage() })
  }
  private finish() {
    this.inFlight = undefined
    this.lastRequestAt = Date.now()
    this.measure()
    this.update({ busy: false, loadingOlder: false })
    prune(this.cache)
  }
}

export function useLogHistory(options: Options) {
  const { workspaces, loader = unavailable, active, query, source, since, until, invalidRange } = options
  const filters = { query, source: source || undefined, since: since || undefined, until: until || undefined }
  const key = JSON.stringify({ owners: workspaces.map(ownerKey).sort(), ...filters })
  let cache = caches.get(loader)
  if (!cache) { cache = new Map(); caches.set(loader, cache) }
  prune(cache)
  let store = cache.get(key)
  if (!store) {
    store = new HistoryStore(cache, loader, workspaces.map(workspace => ({ workspace, request: { ...logIdentity(workspace), ...filters, limit: 200 } })))
    cache.set(key, store)
  }
  const history = store
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot)
  useEffect(() => {
    if (active && !invalidRange && !history.getSnapshot().ready) void history.refresh()
  }, [active, invalidRange, history])
  const results = useMemo(() => {
    const current = new Map(workspaces.map(workspace => [ownerKey(workspace), workspace]))
    return snapshot.results.map(result => ({ ...result, workspace: current.get(ownerKey(result.workspace)) ?? result.workspace }))
  }, [snapshot.results, workspaces])
  const rows = useMemo(() => chronologicalRows(results), [results])
  const refresh = useCallback(() => active && !invalidRange ? history.refresh() : Promise.resolve(), [history, active, invalidRange])
  const loadOlder = useCallback(() => active && !invalidRange ? history.loadOlder() : Promise.resolve(), [history, active, invalidRange])
  const retry = useCallback(() => active && !invalidRange ? history.retry() : Promise.resolve(), [history, active, invalidRange])
  return { ...snapshot, results, rows, hasOlder: results.some(result => Boolean(result.page.nextCursor)), refresh, loadOlder, retry, setScrollTop: history.setScrollTop, setExpandedRows: history.setExpandedRows }
}
