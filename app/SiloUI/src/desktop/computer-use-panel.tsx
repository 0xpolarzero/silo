import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { CircleAlert, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { useChatGptApp, useComputerUseBridge, type ChatGptAppSnapshot, type ChatGptAppStore } from "./computer-use-bridge"
import type { ChatGptAppStatus, ComputerUseApproval, ComputerUseState, LinuxDesktopState } from "./linux-desktop-state"

export const OPENAI_TERMS_URL = "https://openai.com/policies/terms-of-use/"

const stateLabels: Record<ComputerUseState["state"], string> = {
  unavailable: "Unavailable",
  "needs-consent": "Waiting for your approval to download ChatGPT for Linux",
  preparing: "Preparing…",
  installing: "Installing…",
  ready: "Ready",
  failed: "Setup failed",
}
export const computerUseLabel = (state: ComputerUseState["state"]) => stateLabels[state]

function megabytes(bytes: number) {
  return `${Math.max(0, Math.round(bytes / 1_000_000)).toLocaleString("en-US")} MB`
}

/** The one-time notice before Silo downloads the official ChatGPT app for Linux. */
export function ChatGptNotice({ busy, error, onAccept, onNotNow }: { busy: boolean; error?: string | null; onAccept: () => void; onNotNow?: () => void }) {
  const titleId = useId()
  return <div role="group" aria-labelledby={titleId} className="grid gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
    <p id={titleId} className="font-medium">Download ChatGPT for Linux?</p>
    <p className="text-muted-foreground">Silo will download the official ChatGPT app for Linux from OpenAI (about 450 MB, about 1.5 GB on disk, once per computer) so agents in your sandboxes can use the Linux desktop. It is shared by your sandboxes and never installed in them. <a className="underline underline-offset-2" href={OPENAI_TERMS_URL} target="_blank" rel="noreferrer">OpenAI terms of use</a></p>
    {error && <p role="alert" className="flex items-start gap-1 text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 break-words">{error}</span></p>}
    <div className="flex justify-end gap-1.5">
      {onNotNow && <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onNotNow}>Not now</Button>}
      <Button type="button" size="xs" disabled={busy} onClick={onAccept}>Accept</Button>
    </div>
  </div>
}

/** Progress and result of preparing the ChatGPT app. Renders nothing before consent or when idle. */
export function ChatGptAppProgress({ status, busy, error, onRetry }: { status: ChatGptAppStatus; busy: boolean; error?: string | null; onRetry: () => void }) {
  switch (status.state) {
    case "downloading": {
      const total = status.totalBytes ?? 0
      const percent = total > 0 ? Math.min(100, Math.round(status.receivedBytes / total * 100)) : null
      return <div className="grid gap-1.5 text-xs" role="status">
        <p>Downloading ChatGPT for Linux · {total > 0 ? `${megabytes(status.receivedBytes)} of ${megabytes(total)}` : megabytes(status.receivedBytes)}</p>
        <Progress aria-label="Download progress" value={percent} />
      </div>
    }
    case "verifying": return <p role="status" className="text-xs">Verifying the download…</p>
    case "extracting": return <p role="status" className="text-xs">Unpacking ChatGPT for Linux…</p>
    case "failed": return <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{status.reason}</span>
      {status.retryable && <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRetry}>Retry</Button>}
    </div>
    case "idle": return <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">ChatGPT for Linux has not been downloaded yet.</span>
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRetry}>Download</Button>
    </div>
    default: return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null
  }
}

/** The notice and download progress, driven by the shared ChatGPT app store. `showReady` is for
 * the sandbox creation form, which confirms an app that is already in place. */
export function ChatGptAppFlow({ store, dismissable = true, showReady = false }: { store: ChatGptAppStore | undefined; dismissable?: boolean; showReady?: boolean }) {
  const snapshot = useChatGptApp(store)
  const [dismissed, setDismissed] = useState(false)
  return <ChatGptAppFlowView snapshot={snapshot} dismissed={dismissed} showReady={showReady}
    onAccept={() => { void store?.accept() }} onNotNow={dismissable ? () => setDismissed(true) : undefined} onRetry={() => { void store?.prepare() }} />
}

export function ChatGptAppFlowView({ snapshot, dismissed, showReady, onAccept, onNotNow, onRetry }: { snapshot: ChatGptAppSnapshot; dismissed: boolean; showReady: boolean; onAccept: () => void; onNotNow?: () => void; onRetry: () => void }) {
  const { status, busy, error } = snapshot
  if (!status) return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null
  if (status.state === "notConsented") return dismissed
    ? <p className="text-xs text-muted-foreground">Computer use needs ChatGPT for Linux. Silo asks again from the sandbox's details.</p>
    : <ChatGptNotice busy={busy} error={error} onAccept={onAccept} onNotNow={onNotNow} />
  if (status.state === "ready") return showReady ? <p role="status" className="text-xs text-muted-foreground">ChatGPT for Linux is ready{status.version ? ` (${status.version})` : ""}.</p> : null
  return <ChatGptAppProgress status={status} busy={busy} error={error} onRetry={onRetry} />
}

/** Presentational: the state of one VM's built-in computer use. */
export function ComputerUsePanel({ computerUse, running, busy, error, chatGpt, onApproval, onSetup }: {
  computerUse: ComputerUseState
  /** The sandbox and its desktop are running, so setup can run. */
  running: boolean
  busy: boolean
  error: string | null
  /** The ChatGPT download notice or its progress, while the app is not ready. */
  chatGpt?: ReactNode
  onApproval: (mode: ComputerUseApproval) => void
  onSetup: () => void
}) {
  const headingId = useId()
  const switchId = useId()
  const auto = computerUse.approval === "auto"
  const setupDisabled = busy || !running || computerUse.state === "installing" || computerUse.state === "preparing"
  const details = [
    computerUse.appVersion && ["ChatGPT app", computerUse.appVersion],
    computerUse.runtimeVersion && ["Runtime", computerUse.runtimeVersion],
    computerUse.lcuVersion && ["LCU", computerUse.lcuVersion],
    computerUse.agents?.length ? ["Agents", computerUse.agents.join(", ")] : null,
  ].filter((row): row is string[] => Boolean(row))
  return <section aria-labelledby={headingId} className="grid gap-3 rounded-lg border border-border bg-background px-3 py-3 text-xs">
    <div className="grid gap-0.5">
      <h3 id={headingId} className="font-medium">Computer use</h3>
      <p role={computerUse.state === "installing" || computerUse.state === "preparing" ? "status" : undefined} className={computerUse.state === "failed" ? "text-destructive" : "text-muted-foreground"}>
        {computerUseLabel(computerUse.state)}{computerUse.reason ? <span className="block break-words">{computerUse.reason}</span> : null}
      </p>
    </div>
    {chatGpt}
    {computerUse.compatibility === "untested" && <p role="note" className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{computerUse.warning || "This ChatGPT app version has not been tested with Silo. Computer use may not work as expected."}</span>
    </p>}
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={switchId} className="min-w-0">
        Allow without asking
        <span className="mt-1 block text-[11px] text-muted-foreground">Agents' computer-use actions in this sandbox will not ask for approval first. This only affects this sandbox; your files and accounts outside it stay out of reach.</span>
      </label>
      <Switch id={switchId} checked={auto} disabled={busy} onCheckedChange={checked => onApproval(checked ? "auto" : "ask")} />
    </div>
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-[11px] text-muted-foreground">Use after installing a new agent in this sandbox.{!running && " Start the sandbox first."}</span>
      <Button type="button" size="xs" variant="outline" disabled={setupDisabled} onClick={onSetup}>Set up computer use</Button>
    </div>
    {error && <p role="alert" className="flex items-start gap-1 text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 break-words">{error}</span></p>}
    {details.length > 0 && <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer select-none rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">Details</summary>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {details.map(([name, value]) => <div key={name} className="contents"><dt>{name}</dt><dd className="break-words text-foreground">{value}</dd></div>)}
      </dl>
    </details>}
  </section>
}

/** Reads and changes one sandbox's computer use. Renders nothing for pre-v4 sandboxes or without a bridge. */
export function ComputerUseSection({ workspace, pollMs = 5000 }: { workspace: string; pollMs?: number }) {
  const bridge = useComputerUseBridge()
  const [state, setState] = useState<LinuxDesktopState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const working = useRef(false)
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    if (!bridge || working.current) return
    const current = revision.current
    try {
      const next = await bridge.readState(workspace)
      if (current === revision.current) { setState(next); setError(null) }
    } catch (cause) { if (current === revision.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [bridge, workspace])
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh() }, 0)
    const interval = window.setInterval(() => { void refresh() }, pollMs)
    return () => { window.clearTimeout(initial); window.clearInterval(interval) }
  }, [refresh, pollMs])
  const run = useCallback(async (work: () => Promise<LinuxDesktopState>, optimistic?: (state: LinuxDesktopState) => LinuxDesktopState) => {
    if (working.current) return
    working.current = true
    revision.current += 1
    setBusy(true)
    setError(null)
    const previous = state
    if (optimistic) setState(current => current ? optimistic(current) : current)
    try { setState(await work()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setState(previous) }
    finally { working.current = false; setBusy(false) }
  }, [state])
  const computerUse = state?.computerUse
  const needsApp = computerUse?.state === "needs-consent" || computerUse?.state === "preparing"
  if (!bridge || !computerUse) return null
  return <ComputerUsePanel computerUse={computerUse} running={state?.state === "running"} busy={busy} error={error}
    chatGpt={needsApp ? <ChatGptAppFlow store={bridge.chatGpt} dismissable={false} /> : undefined}
    onApproval={mode => { void run(() => bridge.setApproval(workspace, mode), current => ({ ...current, computerUse: current.computerUse ? { ...current.computerUse, approval: mode } : current.computerUse })) }}
    onSetup={() => { void run(() => bridge.setup(workspace), current => ({ ...current, computerUse: current.computerUse ? { ...current.computerUse, state: "installing", reason: null } : current.computerUse })) }} />
}
