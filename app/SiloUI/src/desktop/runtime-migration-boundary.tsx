import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useState, type ReactNode } from "react"
import { AlertCircle, LoaderCircle } from "lucide-react"
import { z } from "zod"
import { SiloWindow } from "@/components/silo-window"
import { Button } from "@/components/ui/button"

const migrationStateSchema = z.object({
  status: z.enum(["not-required", "scanning", "running", "failed", "complete"]),
  stage: z.string(),
  logs: z.array(z.string()),
  migratedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  canContinue: z.boolean(),
  logPath: z.string().optional(),
  error: z.string().optional(),
})

export type RuntimeMigrationState = z.infer<typeof migrationStateSchema>
export interface RuntimeMigrationBackend {
  read: () => Promise<RuntimeMigrationState>
  retry: () => Promise<RuntimeMigrationState>
  continueAfterFailure: () => Promise<RuntimeMigrationState>
  subscribe: (refresh: () => void) => Promise<() => void>
}

const nativeBackend: RuntimeMigrationBackend = {
  read: async () => migrationStateSchema.parse(await invoke("read_runtime_migration_state")),
  retry: async () => migrationStateSchema.parse(await invoke("retry_runtime_migration")),
  continueAfterFailure: async () => migrationStateSchema.parse(await invoke("continue_after_migration_failure")),
  subscribe: async (refresh) => listen("silo://application-state-changed", refresh),
}

function issueUrl(state: RuntimeMigrationState) {
  const title = "Silo VM migration failed"
  const body = [
    "Silo VM migration failed while upgrading the runtime.",
    `Stage: ${state.stage}`,
    `Migrated: ${state.migratedCount} of ${state.totalCount}; failed: ${state.failedCount}.`,
    "Please describe what happened. Attach logs only after checking them for private data.",
  ].join("\n")
  return `https://github.com/0xpolarzero/silo/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

export function RuntimeMigrationBoundary({ children, backend = nativeBackend }: { children: ReactNode; backend?: RuntimeMigrationBackend }) {
  const [state, setState] = useState<RuntimeMigrationState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    let eventSeen = false
    void backend.subscribe(() => {
      eventSeen = true
      void backend.read().then(next => { if (active) { setState(next); setError(null) } }).catch(cause => { if (active) setError(String(cause)) })
    }).then(stop => {
      if (!active) { stop(); return }
      unsubscribe = stop
      return backend.read().then(next => { if (active && !eventSeen) setState(next) })
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false; unsubscribe?.() }
  }, [backend])

  async function run(operation: () => Promise<RuntimeMigrationState>) {
    setBusy(true)
    setError(null)
    try { setState(await operation()) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  if (state?.status === "not-required" || state?.status === "complete") return children
  const failed = state?.status === "failed"
  const issue = state ? issueUrl(state) : null
  return <SiloWindow title="Silo" label="Silo migration">
    <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-8">
      <div className="flex items-start gap-3">
        {failed || error ? <AlertCircle aria-hidden="true" className="mt-0.5 size-5 text-destructive" /> : <LoaderCircle aria-hidden="true" className="mt-0.5 size-5 animate-spin motion-reduce:animate-none" />}
        <div>
          <h1 className="text-lg font-semibold">{failed ? "Some sandboxes could not be migrated" : error ? "Migration status is unavailable" : "Updating your sandboxes"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{state?.stage ?? "Checking saved sandboxes…"}</p>
        </div>
      </div>
      {state && <p role="status" className="text-xs text-muted-foreground">{state.migratedCount} of {state.totalCount} migrated{state.failedCount ? ` · ${state.failedCount} failed` : ""}</p>}
      {(state?.error || error) && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/[.06] p-3 text-sm text-destructive">{error ?? state?.error}</p>}
      {state && <section aria-label="Migration log" className="min-h-0 rounded-md border bg-muted/30">
        <div className="flex items-center justify-between border-b px-3 py-2"><h2 className="text-xs font-medium">Live migration log</h2><Button size="xs" variant="ghost" onClick={() => setShowLogs(value => !value)}>{showLogs ? "Hide logs" : "Show logs"}</Button></div>
        {showLogs && <div className="p-3"><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]" aria-live="polite">{state.logs.length ? state.logs.join("\n") : "Waiting for migration output…"}</pre>{state.logPath && <p className="mt-2 break-all text-[11px] text-muted-foreground">Full log: {state.logPath}</p>}</div>}
      </section>}
      {failed && state && <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/[.05] p-3 text-xs">
        <p>Review the logs and retry. You can back up your work yourself before continuing. Continuing leaves unmigrated originals in place; affected sandboxes may be unavailable in the new runtime.</p>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>I understand that failed sandboxes have not been converted and will remain unavailable until recovered.</span></label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void run(backend.retry)}>Retry migration</Button>
          {issue && <Button size="sm" variant="outline" asChild><a href={issue} target="_blank" rel="noopener noreferrer">Prepare GitHub issue</a></Button>}
          <Button size="sm" variant="outline" disabled={busy || !acknowledged || !state.canContinue} onClick={() => void run(backend.continueAfterFailure)}>Continue with available sandboxes</Button>
        </div>
      </div>}
    </main>
  </SiloWindow>
}
