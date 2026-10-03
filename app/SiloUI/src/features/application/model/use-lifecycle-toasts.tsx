import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react"

import { ErrorDetails } from "@/components/error-details"
import { dismissOperationToast, showOperationFailure, showOperationNotice, showOperationProgress } from "@/lib/operation-toast"
import type { ApplicationActions, ApplicationSource, ApplicationWorkspace } from "./application-source"
import { lifecycleGuard } from "./lifecycle-guard"
import { startStepProgress } from "./lifecycle-progress"
import { cancelledActionLabel, emptyOperationQueue, waitingOperationForVm, waitingStatusText } from "./operation-queue"

const LIFECYCLE_TOAST_DELAY_MS = 800

/** Track lifecycle notifications independently of the visible page. */
export function useLifecycleToasts(source: ApplicationSource, actions: ApplicationActions, { enabled = true, readOnly = false } = {}) {
  const latest = useRef({ source, actions, readOnly })
  useLayoutEffect(() => { latest.current = { source, actions, readOnly } }, [source, actions, readOnly])

  function retry(workspace: ApplicationWorkspace): (() => void) | undefined {
    const action = workspace.lifecycleFailureAction ?? "start"
    if (readOnly || !workspace.lifecycleFailure || action === "dismiss-error") return undefined
    return () => {
      const current = latest.current
      const fresh = current.source.workspaces.find(item => item.machine.id === workspace.machine.id)
      if (fresh && !current.readOnly) lifecycleGuard(current.source, current.actions).confirm(fresh, action)
    }
  }

  // Lifecycle Start/Stop/Restart: a progress notification appears only if the action takes
  // longer than a moment (instant ones never flash) and is dismissed when it finishes; the row
  // state already shows the outcome. Failures keep their own retryable notification.
  const lifecycleProgress = useRef(new Map<string, { timer?: number; shown: boolean; startedAt: number; show: () => void }>())
  const trackLifecycle = useEffectEvent((all: ApplicationWorkspace[]) => {
    const tracked = lifecycleProgress.current
    const live = new Set<string>()
    for (const workspace of all) {
      const action = workspace.lifecycleAction
      if (!action || action === "dismiss-error") continue
      const key = `${workspace.device?.id ?? ""}:${workspace.machine.id}`
      live.add(key)
      const id = `lifecycle:${key}`
      const name = workspace.machine.name
      const title = action === "restart" ? `Restarting ${name}` : action === "stop" ? `Stopping ${name}` : `Starting ${name}`
      const waiting = !workspace.device ? waitingOperationForVm(source.operationQueue ?? emptyOperationQueue, workspace.machine.id) : undefined
      const starting = action === "start" || action === "restart"
      // Remote devices report no steps, so their start keeps the plain text.
      const reported = starting && !workspace.device ? startStepProgress(workspace.lifecycleStep) : undefined
      const step = waiting && source.operationQueue ? waitingStatusText(source.operationQueue, waiting) : reported ? reported.step : action === "restart" ? "Restarting…" : action === "stop" ? "Stopping…" : "Starting…"
      const progress = waiting ? undefined : reported?.progress
      const existing = tracked.get(key)
      const entry = existing ?? { shown: false, startedAt: Date.now(), show: () => {} } as { timer?: number; shown: boolean; startedAt: number; show: () => void }
      entry.show = () => showOperationProgress(id, { title, step, progress, startedAt: entry.startedAt, sandbox: name })
      if (!existing) {
        tracked.set(key, entry)
        // A start always takes a while, so its toast is immediate; a stop that is instant never flashes.
        if (starting) { entry.shown = true; entry.show() }
        else entry.timer = window.setTimeout(() => { entry.shown = true; entry.timer = undefined; entry.show() }, LIFECYCLE_TOAST_DELAY_MS)
      } else if (entry.shown) entry.show()
    }
    for (const [key, entry] of tracked) {
      if (live.has(key)) continue
      if (entry.timer) window.clearTimeout(entry.timer)
      if (entry.shown && !all.some(workspace => `${workspace.device?.id ?? ""}:${workspace.machine.id}` === key && workspace.lifecycleFailure)) dismissOperationToast(`lifecycle:${key}`)
      tracked.delete(key)
    }
  })
  useEffect(() => { if (enabled) trackLifecycle(source.workspaces) }, [enabled, source.workspaces, source.operationQueue])
  useEffect(() => {
    const tracked = lifecycleProgress.current
    return () => {
      for (const [key, entry] of tracked) {
        if (entry.timer) window.clearTimeout(entry.timer)
        if (entry.shown) dismissOperationToast(`lifecycle:${key}`)
      }
      tracked.clear()
    }
  }, [enabled])

  // Lifecycle failures and cancellations arrive from the backend as workspace state. Toast each
  // new one (both the list and the detail page render from here); failures already present at
  // first load keep only their row state label.
  const seenLifecycleFailures = useRef<Map<string, string> | null>(null)
  const lifecycleToasts = useEffectEvent((all: ApplicationWorkspace[]) => {
    const current = new Map<string, string>()
    for (const workspace of all) {
      if (workspace.lifecycleFailure) current.set(`${workspace.device?.id ?? ""}:${workspace.machine.id}`, `${workspace.lifecycleFailureAction ?? ""}|${workspace.lifecycleFailure}`)
    }
    const previous = seenLifecycleFailures.current
    seenLifecycleFailures.current = current
    if (!previous) return
    for (const workspace of all) {
      const key = `${workspace.device?.id ?? ""}:${workspace.machine.id}`
      const signature = current.get(key)
      if (!signature || previous.get(key) === signature) continue
      const action = workspace.lifecycleFailureAction ?? "start"
      const name = workspace.machine.name
      const id = `lifecycle:${key}`
      if (workspace.lifecycleFailureCancelled) {
        showOperationNotice(id, cancelledActionLabel(action))
        continue
      }
      if (action === "dismiss-error") continue
      const verb = action === "restart" ? "restart" : action === "stop" ? "stop" : "start"
      dismissOperationToast(id)
      showOperationFailure(id, `Could not ${verb} ${name}`, { description: workspace.lifecycleFailure ? <ErrorDetails message={workspace.lifecycleFailure} diagnostic={workspace.lifecycleFailureDiagnostic} /> : undefined, retry: retry(workspace), sandbox: name, native: false })
    }
  })
  useEffect(() => { if (enabled) lifecycleToasts(source.workspaces) }, [enabled, source.workspaces])
}
