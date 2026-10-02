import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { CircleAlert, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { computerOfWorkspace, useChatGptApp, useComputerUseBridge, type ChatGptAppStore } from "./computer-use-bridge"
import { computerUseLabel } from "./computer-use-labels"
import type { ChatGptAppStatus, ComputerUseApproval, ComputerUseState, LinuxDesktopState } from "./linux-desktop-state"

function megabytes(bytes: number) {
  return `${Math.max(0, Math.round(bytes / 1_000_000)).toLocaleString("en-US")} MB`
}

function ErrorLine({ message, actionLabel, onAction, onDismiss, busy }: { message: string; actionLabel?: string; onAction?: () => void; onDismiss?: () => void; busy?: boolean }) {
  return <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
    <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
    <span className="min-w-0 flex-1 break-words">{message}</span>
    {onAction && <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onAction}>{actionLabel}</Button>}
    {onDismiss && <Button type="button" size="xs" variant="ghost" aria-label="Dismiss error" onClick={onDismiss}>Dismiss</Button>}
  </div>
}

/** What Silo tells the user about the ChatGPT app. It downloads it by itself: nothing to accept. */
export const CHATGPT_DOWNLOAD_NOTE = "Silo downloads ChatGPT for Linux from OpenAI so agents in your sandboxes can use the Linux desktop."

/** Progress and result of preparing the ChatGPT app, read-only: a Retry button appears only with `onRetry`. */
export function ChatGptAppProgress({ status, busy = false, onRetry }: { status: ChatGptAppStatus; busy?: boolean; onRetry?: () => void }) {
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
      {onRetry && <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRetry}>Retry</Button>}
    </div>
    case "idle": return <p role="status" className="text-xs text-muted-foreground">ChatGPT for Linux will download shortly.</p>
    default: return null
  }
}

/** The progress of the ChatGPT download of a sandbox's computer. `retry` adds Retry to a failure, which acts on that computer's download.
 * `fallbackReason` is shown with Retry until the status itself is read. */
export function ChatGptAppStatusView({ store, retry = false, fallbackReason }: { store: ChatGptAppStore | undefined; retry?: boolean; fallbackReason?: string | null }) {
  const { status, busy, error, loadError, subscriptionError } = useChatGptApp(store)
  const recovery = subscriptionError ?? loadError
  const refresh = recovery ? <ErrorLine message={recovery} actionLabel="Refresh status" onAction={store ? () => { void store.refresh() } : undefined} /> : null
  const onRetry = retry && store ? () => { void store.retry() } : undefined
  if (!status) {
    if (refresh) return refresh
    return fallbackReason ? <ErrorLine message={fallbackReason} actionLabel={onRetry ? "Retry" : undefined} onAction={onRetry} busy={busy} /> : null
  }
  if (status.state === "ready" || status.state === "unknown") return <>{fallbackReason && <ErrorLine message={fallbackReason} />}{refresh}</>
  return <div className="grid gap-1.5">
    <ChatGptAppProgress status={status} busy={busy} onRetry={onRetry} />
    {refresh}
    {error && <ErrorLine message={error} onDismiss={() => store?.dismissError()} />}
  </div>
}

/** What the viewer says after it updates the tools: running agent sessions only load them when they reconnect. */
export const SETUP_DONE = "Computer use is set up. Reconnect agent sessions to load computer use."

/** Presentational: the state of one VM's built-in computer use. */
export function ComputerUsePanel({ computerUse, running, busy, error, loadError, notice, chatGpt, onApproval, onSetup, onDismissError, onReload }: {
  computerUse: ComputerUseState
  /** The sandbox and its desktop are running, so setup can run. */
  running: boolean
  busy: boolean
  /** The last change failed. Kept until the next change or dismissal. */
  error: string | null
  /** The latest read of the sandbox's state failed; what is shown may be stale. */
  loadError?: string | null
  /** Setup just succeeded: announced, kept until the next change. */
  notice?: string | null
  onDismissError?: () => void
  onReload?: () => void
  /** The ChatGPT download progress, read-only, while the app is not ready. */
  chatGpt?: ReactNode
  onApproval: (mode: ComputerUseApproval) => void
  onSetup: () => void
}) {
  const headingId = useId()
  const switchId = useId()
  const auto = computerUse.approval === "auto"
  const unknownApproval = computerUse.approval === "unknown"
  // Silo drives the sandbox toward the chosen mode itself and keeps the last result: the switch
  // shows the choice, `approvalApply` how applying it stands, `appliedApproval` the last mode that was applied.
  const apply = computerUse.approvalApply
  const applied = computerUse.appliedApproval
  const applying = apply === "pending" && running
  const waitsForStart = apply === "pending" && !running && applied !== "unknown" && applied !== computerUse.approval
  // After choosing ask, agents may still act without asking when the previous applied mode was auto, only
  // some agents were changed, or the change failed and nothing says ask is in place.
  const mayActWithoutAsking = computerUse.approval === "ask" && (applied === "auto" || apply === "partial" || (apply === "failed" && applied !== "ask"))
  const mayStillAsk = computerUse.approval === "auto" && (apply === "partial" || apply === "failed" || applied === "ask")
  const problem = apply === "failed" ? "Silo could not apply the approval change." : apply === "partial" ? "Silo changed the approval setting for only some agents." : null
  // An older owner does not report `approvalApply` but still reports both modes: whatever the
  // result says, a chosen mode that differs from the applied one is not in place yet.
  const differs = !unknownApproval && applied !== "unknown" && applied !== computerUse.approval
  const showApproval = !unknownApproval && (problem || ((apply === "pending" || differs) && (mayActWithoutAsking || mayStillAsk)))
  const downloadFailed = computerUse.state === "failed" && computerUse.cause === "app-download"
  const setupDisabled = busy || !running || downloadFailed || computerUse.state === "installing" || computerUse.state === "preparing"
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
        {computerUseLabel(computerUse.state, computerUse.cause)}{computerUse.reason && !(downloadFailed && chatGpt) ? <span className="block break-words">{computerUse.reason}</span> : null}
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
        <span className="mt-1 block text-[11px] text-muted-foreground">Agents that ask before using the computer, such as Claude Code and Codex, stop asking in this sandbox. Other agents may not ask either way. It does not limit what an agent can do in accounts you are signed in to inside this sandbox. The switch configures the agents' approval prompts; it is not a security boundary inside the sandbox.</span>
      </label>
      <Switch id={switchId} checked={auto} disabled={busy || unknownApproval} onCheckedChange={checked => onApproval(checked ? "auto" : "ask")} />
    </div>
    {unknownApproval && <p role="note" className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">Silo could not read this sandbox's approval setting. Agents may be running without asking. Changes are disabled until it can be read.</span>
    </p>}
    {applying && <p role="status" className="text-muted-foreground">Applying…</p>}
    {waitsForStart && <p className="text-muted-foreground">Applied when the sandbox starts.</p>}
    {showApproval && <p role="note" className={mayActWithoutAsking ? "flex items-start gap-1.5 text-amber-700 dark:text-amber-400" : "flex items-start gap-1.5 text-muted-foreground"}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        {problem}{problem && computerUse.approvalApplyReason ? ` ${computerUse.approvalApplyReason}` : ""}{problem ? " " : ""}
        {mayActWithoutAsking ? `Some agents in this sandbox may still act without asking${apply === "pending" ? " until this change is applied" : ""}.`
          : mayStillAsk ? `Some agents in this sandbox may still ask first${apply === "pending" ? " until this change is applied" : ""}.` : null}
      </span>
    </p>}
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-[11px] text-muted-foreground">Use after installing a new agent in this sandbox.{!running && " Start the sandbox first."}{downloadFailed && " It becomes possible once the ChatGPT download finishes: use Retry above."}</span>
      <Button type="button" size="xs" variant="outline" disabled={setupDisabled} onClick={onSetup}>Set up computer use</Button>
    </div>
    {notice && <p role="status" className="text-xs">{notice}</p>}
    {error && <ErrorLine message={error} onDismiss={onDismissError} />}
    {loadError && <ErrorLine message={loadError} actionLabel="Try again" onAction={onReload} />}
    {details.length > 0 && <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer select-none rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">Details</summary>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {details.map(([name, value]) => <div key={name} className="contents"><dt>{name}</dt><dd className="break-words text-foreground">{value}</dd></div>)}
      </dl>
    </details>}
  </section>
}

/** Reads and changes one sandbox's computer use. Renders nothing for pre-v4 sandboxes or without a bridge.
 * Mount with `key={workspace}`: its reads belong to one sandbox. */
export function ComputerUseSection({ workspace, pollMs = 5000 }: { workspace: string; pollMs?: number }) {
  const bridge = useComputerUseBridge()
  const [state, setState] = useState<LinuxDesktopState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const working = useRef(false)
  const reading = useRef(false)
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    // One read at a time, so a slow one can never be overtaken by a newer one and then overwrite it.
    if (!bridge || working.current || reading.current) return
    reading.current = true
    const current = revision.current
    try {
      const next = await bridge.readState(workspace)
      if (current === revision.current) { setState(next); setLoadError(null) }
    } catch (cause) { if (current === revision.current) setLoadError(cause instanceof Error ? cause.message : String(cause)) }
    finally { reading.current = false }
  }, [bridge, workspace])
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh() }, 0)
    const interval = window.setInterval(() => { void refresh() }, pollMs)
    return () => { window.clearTimeout(initial); window.clearInterval(interval) }
  }, [refresh, pollMs])
  const run = useCallback(async (work: () => Promise<LinuxDesktopState>, optimistic?: (state: LinuxDesktopState) => LinuxDesktopState, announce?: string) => {
    if (working.current) return
    working.current = true
    revision.current += 1
    setBusy(true)
    setError(null)
    setNotice(null)
    const previous = state
    if (optimistic) setState(current => current ? optimistic(current) : current)
    try {
      const next = await work()
      setState(next); setLoadError(null)
      if (announce && next.computerUse?.state === "ready") setNotice(announce)
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      // The change may have been stored or even applied before it failed to answer: show what the
      // sandbox's own state says now, not the snapshot from before the change. Only when that read
      // fails too does the old snapshot stand, with its read error.
      try { setState(await bridge?.readState(workspace) ?? previous); setLoadError(null) }
      catch (readCause) { setLoadError(readCause instanceof Error ? readCause.message : String(readCause)); setState(previous) }
    }
    finally { working.current = false; setBusy(false) }
  }, [bridge, state, workspace])
  if (!bridge) return null
  if (!state) return loadError ? <LoadFailure message={loadError} onReload={() => { void refresh() }} /> : null
  const computerUse = state.computerUse
  // A loaded state without computerUse is a sandbox from before it was built in.
  if (!computerUse) return null
  const downloadFailed = computerUse.state === "failed" && computerUse.cause === "app-download"
  const needsApp = computerUse.state === "preparing" || downloadFailed
  return <ComputerUsePanel computerUse={computerUse} running={state.state === "running"} busy={busy} error={error} loadError={loadError} notice={notice}
    onDismissError={() => setError(null)} onReload={() => { void refresh() }}
    chatGpt={needsApp ? <ChatGptAppStatusView store={bridge.chatGptFor(computerOfWorkspace(workspace))} retry={downloadFailed} fallbackReason={downloadFailed ? computerUse.reason : null} /> : undefined}
    onApproval={mode => { void run(() => bridge.setApproval(workspace, mode), current => ({ ...current, computerUse: current.computerUse ? { ...current.computerUse, approval: mode, approvalApply: "pending", approvalApplyReason: null } : current.computerUse })) }}
    onSetup={() => { void run(() => bridge.setup(workspace), current => ({ ...current, computerUse: current.computerUse ? { ...current.computerUse, state: "installing", reason: null } : current.computerUse }), SETUP_DONE) }} />
}

function LoadFailure({ message, onReload }: { message: string; onReload: () => void }) {
  const headingId = useId()
  return <section aria-labelledby={headingId} className="grid gap-2 rounded-lg border border-border bg-background px-3 py-3 text-xs">
    <h3 id={headingId} className="font-medium">Computer use</h3>
    <ErrorLine message={message} actionLabel="Try again" onAction={onReload} />
  </section>
}
