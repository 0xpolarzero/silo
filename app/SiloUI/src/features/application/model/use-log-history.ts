import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import type { ApplicationWorkspace } from "./application-source"
import { isUnsupportedRemote, logIdentity, LOG_ROW_HEIGHT, type LogEntry, type LogLoader, type LogPage, type LogQuery } from "./logs"

export type LogHistoryRow = { entry: LogEntry; workspace: ApplicationWorkspace }
export type LogHistoryResult = { workspace: ApplicationWorkspace; page: LogPage; request: LogQuery }
type OrderKey = Pick<LogEntry, "occurredAt" | "id" | "computerId" | "sandboxId">
type CachedResult = LogHistoryResult & { cursors: Set<string>; frontier?: OrderKey }
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
  historyLimited: boolean
}

// Backend snapshots expire after 30 minutes. Inactive views expire sooner and
// share a bounded LRU. Active views keep a rolling window while paging older logs.
const CACHE_TTL = 10 * 60 * 1000
const MAX_CACHED_VIEWS = 8
const MAX_CACHED_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_RECORDS = 5_000
const MAX_HISTORY_BYTES = 8 * 1024 * 1024
const MAX_RECENT_CURSORS = 64
const caches = new WeakMap<LogLoader, Map<string, HistoryStore>>()
const unavailable: LogLoader = async () => { throw new Error("Retained log service unavailable") }
function unsupportedPage(): LogPage {
  return { entries: [], nextCursor: null, oldestAvailableTimestamp: null, newestAvailableTimestamp: null, totalMatches: 0, timestampEstimated: false, unsupported: true }
}
function list(names: string[]): string {
  return names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`
}
/** One plain notice per computer whose Silo cannot serve logs, instead of a raw error per sandbox. */
export function unsupportedLogsNotice(results: LogHistoryResult[]): string {
  const byComputer = new Map<string, string[]>()
  for (const { workspace, page } of results) {
    if (!page.unsupported) continue
    const computer = workspace.computer?.name ?? "that computer"
    byComputer.set(computer, [...(byComputer.get(computer) ?? []), workspace.machine.name])
  }
  return [...byComputer].map(([computer, names]) => `Update Silo on ${computer} to see logs for ${list(names)}.`).join(" ")
}
function ownerKey(workspace: ApplicationWorkspace): string {
  const identity = logIdentity(workspace)
  return JSON.stringify([identity.computerId ?? "local", identity.sandboxId])
}
function entryKey(entry: LogEntry): string {
  return JSON.stringify([entry.computerId, entry.sandboxId, entry.id])
}
function descending(a: string, b: string): number { return a === b ? 0 : a < b ? 1 : -1 }
function newestFirst(a: { entry: OrderKey }, b: { entry: OrderKey }): number {
  return descending(a.entry.occurredAt, b.entry.occurredAt)
    || descending(a.entry.id, b.entry.id)
    || descending(a.entry.computerId, b.entry.computerId)
    || descending(a.entry.sandboxId, b.entry.sandboxId)
}
function pageFrontier(page: LogPage): OrderKey | undefined {
  const entry = page.nextCursor ? page.entries.at(-1) : undefined
  return entry && { occurredAt: entry.occurredAt, id: entry.id, computerId: entry.computerId, sandboxId: entry.sandboxId }
}
function chronologicalRows(results: CachedResult[]): LogHistoryRow[] {
  // Buffer older rows until every owner's unread history is older as well, so
  // paging a busy owner cannot insert records above a quiet owner's visible rows.
  const frontiers = results.flatMap(({ frontier }) => {
    return frontier ? [{ entry: frontier }] : []
  }).sort(newestFirst)
  const frontier = frontiers[0]
  return results.flatMap(({ workspace, page }) => page.entries.map(entry => ({ entry, workspace })))
    .filter(row => !frontier || newestFirst(row, frontier) <= 0)
    .sort(newestFirst)
}
function entryBytes(entry: LogEntry): number {
  return 256 + 2 * (entry.line.length + entry.id.length + entry.occurredAt.length + entry.source.length + (entry.session?.length ?? 0) + entry.computerId.length + entry.sandboxId.length + (entry.computerName?.length ?? 0) + (entry.sandboxName?.length ?? 0))
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
  private snapshot: Snapshot = { results: [], busy: false, loadingOlder: false, ready: false, error: "", scrollTop: 0, expandedRows: new Map(), historyLimited: false }
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
  private retain(results: CachedResult[], older: boolean): Partial<Snapshot> {
    const ordered = results.flatMap(result => result.page.entries.map(entry => ({ entry }))).sort(newestFirst)
    const retained = new Set<LogEntry>()
    let bytes = 0
    // Paging keeps the older end; a new search keeps the latest end. Frontiers
    // contain only ordering keys so eviction never retains discarded log bodies.
    for (const { entry } of older ? ordered.reverse() : ordered) {
      const size = entryBytes(entry)
      if (size > MAX_HISTORY_BYTES) continue
      if (retained.size >= MAX_HISTORY_RECORDS || bytes + size > MAX_HISTORY_BYTES) break
      retained.add(entry)
      bytes += size
    }
    this.bytes = bytes
    const keys = new Set([...retained].map(entryKey))
    const expandedRows = new Map([...this.snapshot.expandedRows].filter(([key]) => keys.has(key)))
    if (retained.size === ordered.length) return { results, expandedRows }
    const removedHeight = chronologicalRows(this.snapshot.results).reduce((height, { entry }) => height + (retained.has(entry) ? 0 : this.snapshot.expandedRows.get(entryKey(entry)) ?? LOG_ROW_HEIGHT), 0)
    return {
      results: results.map(result => ({ ...result, page: { ...result.page, entries: result.page.entries.filter(entry => retained.has(entry)) } })),
      historyLimited: true,
      scrollTop: older ? Math.max(0, this.snapshot.scrollTop - removedHeight) : 0,
      expandedRows,
    }
  }
  setScrollTop = (scrollTop: number) => {
    if (scrollTop !== this.snapshot.scrollTop) this.update({ scrollTop })
  }
  setExpandedRows = (update: (current: ReadonlyMap<string, number>) => ReadonlyMap<string, number>) => {
    const expandedRows = update(this.snapshot.expandedRows)
    if (expandedRows !== this.snapshot.expandedRows) this.update({ expandedRows })
  }
  /** `follow`: continue each owner's previous snapshot, reading only appended records. */
  refresh = (follow = false): Promise<void> => {
    if (this.inFlight) return this.inFlight
    this.update({ busy: true, loadingOlder: false })
    this.inFlight = this.fetchFirst(follow).finally(() => this.finish())
    return this.inFlight
  }
  private async fetchFirst(follow: boolean) {
    const previous = new Map(this.snapshot.results.map(result => [ownerKey(result.workspace), result]))
    const settled = await Promise.allSettled(this.requests.map(async ({ workspace, request }): Promise<CachedResult> => {
      const snapshot = follow ? previous.get(ownerKey(workspace))?.page.snapshot : undefined
      // The stored request stays a plain search: pagination and export never follow.
      const page = await this.loader(snapshot ? { ...request, follow: snapshot } : request)
      return { workspace, request, page, frontier: pageFrontier(page), cursors: new Set() }
    }))
    const results: CachedResult[] = []
    this.errors.clear()
    this.failedPaging.clear()
    this.stalled = false
    for (const [index, value] of settled.entries()) {
      const { workspace } = this.requests[index]
      const key = ownerKey(workspace)
      if (value.status === "fulfilled") results.push(value.value)
      else if (isUnsupportedRemote(value.reason)) results.push({ workspace, request: this.requests[index].request, cursors: new Set(), page: unsupportedPage() })
      else {
        const retained = previous.get(key)
        if (retained) results.push(retained)
        this.errors.set(key, `${workspace.machine.name}: ${String(value.reason)}`)
      }
    }
    const historyLimited = this.snapshot.historyLimited && results.some(result => previous.get(ownerKey(result.workspace)) === result)
    this.update({ historyLimited, ...this.retain(results, false), ready: true, error: this.errorMessage(), ...(settled.some(value => value.status === "fulfilled") && { scrollTop: 0 }) })
  }
  loadOlder = (): Promise<void> => this.pageOlder()
  retry = (): Promise<void> => this.failedPaging.size && !this.stalled ? this.pageOlder(this.failedPaging) : this.refresh()
  private pageOlder(onlyOwners?: Set<string>): Promise<void> {
    if (this.inFlight) return this.inFlight
    const unfinished = this.snapshot.results.filter(result => result.page.nextCursor)
    const frontier = unfinished.flatMap(result => result.frontier ? [{ entry: result.frontier }] : []).sort(newestFirst)[0]
    // Read only the next chronological frontier, leaving quieter owners' buffered
    // pages untouched until their records can become visible.
    const requested = unfinished.filter(result => onlyOwners ? onlyOwners.has(ownerKey(result.workspace)) : !frontier || !result.frontier || (descending(result.frontier.occurredAt, frontier.entry.occurredAt) || descending(result.frontier.id, frontier.entry.id)) <= 0)
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
      if (cursors.size > MAX_RECENT_CURSORS) cursors.delete(cursors.values().next().value!)
      const merged = new Map(result.page.entries.map(entry => [entryKey(entry), entry]))
      for (const entry of page.entries) merged.set(entryKey(entry), entry)
      const didNotAdvance = Boolean(page.nextCursor && (cursors.has(page.nextCursor) || merged.size === result.page.entries.length || result.frontier && !page.entries.some(entry => newestFirst({ entry }, { entry: result.frontier! }) > 0)))
      if (didNotAdvance) {
        this.errors.set(key, `${result.workspace.machine.name}: Log history did not advance. Refresh to continue.`)
        this.stalled = true
      }
      const entries = [...merged.values()].sort((a, b) => newestFirst({ entry: a }, { entry: b }))
      const nextPage = { ...page, entries, nextCursor: didNotAdvance ? null : page.nextCursor }
      updates.set(key, { ...result, cursors, frontier: didNotAdvance ? undefined : pageFrontier(page), page: nextPage })
    }
    this.update({ ...this.retain(this.snapshot.results.map(result => updates.get(ownerKey(result.workspace)) ?? result), true), error: this.errorMessage() })
  }
  private finish() {
    this.inFlight = undefined
    this.lastRequestAt = Date.now()
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
  const orderedRows = useMemo(() => chronologicalRows(snapshot.results), [snapshot.results])
  const rows = useMemo(() => {
    const current = new Map(workspaces.map(workspace => [ownerKey(workspace), workspace]))
    return orderedRows.map(row => ({ ...row, workspace: current.get(ownerKey(row.workspace)) ?? row.workspace }))
  }, [orderedRows, workspaces])
  const refresh = useCallback(() => active && !invalidRange ? history.refresh() : Promise.resolve(), [history, active, invalidRange])
  const follow = useCallback(() => active && !invalidRange ? history.refresh(true) : Promise.resolve(), [history, active, invalidRange])
  const loadOlder = useCallback(() => active && !invalidRange ? history.loadOlder() : Promise.resolve(), [history, active, invalidRange])
  const retry = useCallback(() => active && !invalidRange ? history.retry() : Promise.resolve(), [history, active, invalidRange])
  const unsupportedNotice = useMemo(() => unsupportedLogsNotice(results), [results])
  return { ...snapshot, results, rows, unsupportedNotice, hasOlder: results.some(result => Boolean(result.page.nextCursor)), refresh, follow, loadOlder, retry, setScrollTop: history.setScrollTop, setExpandedRows: history.setExpandedRows }
}
