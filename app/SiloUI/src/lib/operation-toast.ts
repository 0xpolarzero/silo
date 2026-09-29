import { createElement, useEffect, useRef, type ReactNode } from "react"
import { toast } from "sonner"

import { OperationToastBody, type OperationProgressOptions } from "@/components/operation-toast-body"

export type { OperationCancel, OperationProgressOptions, OperationStep } from "@/components/operation-toast-body"

/**
 * When to use what: ask in a popover (components/confirm-popover.tsx), do in a progress
 * toast (this file). Popovers close immediately on confirm; the work continues in a toast
 * with the same stable `id` (progress → success/failure replace each other in place).
 * Dialogs are reserved for the ⌘K palette and the quit overlay.
 *
 *   showOperationProgress(id, { title, step, steps, progress, startedAt, cancel })
 *   showOperationSuccess(id, title, { action })   // stays until closed
 *   showOperationFailure(id, title, { retry })    // stays, with Retry
 *   useOperationProgressToast(id, state)          // for backend-driven operation state
 *
 */
/**
 * One consistent notification lifecycle for background actions:
 * loading → success (stays until the user closes it) or failure (stays, with Retry).
 * Use a stable `id` per operation so each phase replaces the previous toast in place.
 */
export interface OperationToastCopy {
  /** Shown while the action runs, e.g. "Pushing 2 commits". */
  loading: string
  /** Shown when it finishes, e.g. "Pushed 2 commits". */
  success: string
  /** Title when it fails, e.g. "Push failed". The error message becomes the description. */
  failure: string
  /** Optional secondary line for the loading and success phases. */
  description?: string
}

export interface OperationToastOptions {
  /** Called by the failure toast's Retry action. Omit when a retry makes no sense. */
  retry?: () => void
  /** Extra success action, e.g. { label: "Show in Finder", onClick }. */
  successAction?: { label: string; onClick: () => void }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A result-toast action: a label + handler, or a ready-made element such as a `<Button>`. */
export type OperationAction = { label: string; onClick: () => void } | ReactNode

/** Options shared by every finished-state notification. */
export interface OperationResultOptions {
  description?: ReactNode
  action?: OperationAction
  /** Called when the user closes the notification or it closes by itself. */
  onDismiss?: () => void
}

export function showOperationSuccess(id: string, title: string, options: OperationResultOptions = {}) {
  toast.success(title, { id, description: options.description, duration: Infinity, closeButton: true, action: options.action, onDismiss: options.onDismiss, onAutoClose: options.onDismiss })
}

export function showOperationFailure(id: string, title: string, options: Omit<OperationResultOptions, "action"> & { retry?: () => void; action?: OperationAction; tone?: "error" | "warning" } = {}) {
  const notify = options.tone === "warning" ? toast.warning : toast.error
  notify(title, {
    id,
    description: options.description,
    duration: Infinity,
    closeButton: true,
    action: options.action ?? (options.retry ? { label: "Retry", onClick: options.retry } : undefined),
    onDismiss: options.onDismiss,
    onAutoClose: options.onDismiss,
  })
}

/** Close a notification (e.g. when the state it reported has gone away). */
export function dismissOperationToast(id: string) {
  toast.dismiss(id)
}

/** A neutral, short-lived notice for an outcome that is neither success nor failure (e.g. cancelled). */
export function showOperationNotice(id: string, title: string, options: { description?: ReactNode; onDismiss?: () => void; duration?: number } = {}) {
  toast(title, { id, description: options.description, duration: options.duration ?? 4000, closeButton: true, onDismiss: options.onDismiss, onAutoClose: options.onDismiss })
}

/**
 * Rich progress toast: progress bar (determinate when `progress` is 0–1, else indeterminate),
 * current step, optional step list, elapsed time and an optional Cancel (with in-toast confirm).
 * Call again with the same id to update in place.
 */
export function showOperationProgress(id: string, options: OperationProgressOptions) {
  const { title, ...body } = options
  toast.loading(title, { id, duration: Infinity, description: createElement(OperationToastBody, body) })
}

/** Backend-driven operation state understood by `useOperationProgressToast`. */
export type OperationProgressState =
  | { status: "idle" }
  | ({ status: "running" } & OperationProgressOptions)
  | ({ status: "success"; title: string } & OperationResultOptions)
  | { status: "failure"; title: string; description?: ReactNode; retry?: () => void; onDismiss?: () => void }

/**
 * Maps an operation state to progress/success/failure toasts under `id`. A state that is
 * already finished when the component mounts is ignored (no stale toast); running states
 * update in place; going back to idle dismisses a progress toast this hook showed.
 */
export function useOperationProgressToast(id: string, state: OperationProgressState) {
  const previous = useRef<OperationProgressState["status"] | null>(null)
  useEffect(() => {
    const before = previous.current
    previous.current = state.status
    if (state.status === "running") {
      const { status: _status, ...options } = state
      showOperationProgress(id, options)
    } else if (before === null) {
      return
    } else if (state.status === "success" && before !== "success") {
      showOperationSuccess(id, state.title, { description: state.description, action: state.action, onDismiss: state.onDismiss })
    } else if (state.status === "failure" && before !== "failure") {
      showOperationFailure(id, state.title, { description: state.description, retry: state.retry, onDismiss: state.onDismiss })
    } else if (state.status === "idle" && before === "running") {
      toast.dismiss(id)
    }
  }, [id, state])
}

/** Run a user-initiated action with the standard loading → success/failure notifications. */
export async function runWithOperationToast<T>(id: string, copy: OperationToastCopy, action: () => Promise<T>, options: OperationToastOptions = {}): Promise<T | undefined> {
  showOperationProgress(id, { title: copy.loading, step: copy.description, progress: null })
  try {
    const result = await action()
    showOperationSuccess(id, copy.success, { description: copy.description, action: options.successAction })
    return result
  } catch (error) {
    showOperationFailure(id, copy.failure, { description: errorMessage(error), retry: options.retry })
    return undefined
  }
}

/** A short confirmation for instant actions (copy, open). Auto-dismisses. */
export function showQuickConfirmation(title: string, description?: string) {
  toast.success(title, { description, duration: 3000 })
}

/** A standalone failure for an instant action that failed (no loading phase). Stays until closed. */
export function showActionFailure(title: string, error: unknown, retry?: () => void) {
  toast.error(title, {
    description: errorMessage(error),
    duration: Infinity,
    closeButton: true,
    action: retry ? { label: "Retry", onClick: retry } : undefined,
  })
}
