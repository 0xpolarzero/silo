import { toast } from "sonner"

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

export function showOperationLoading(id: string, title: string, description?: string) {
  toast.loading(title, { id, description, duration: Infinity })
}

export function showOperationSuccess(id: string, title: string, options: { description?: string; action?: { label: string; onClick: () => void } } = {}) {
  toast.success(title, { id, description: options.description, duration: Infinity, closeButton: true, action: options.action })
}

export function showOperationFailure(id: string, title: string, options: { description?: string; retry?: () => void } = {}) {
  toast.error(title, {
    id,
    description: options.description,
    duration: Infinity,
    closeButton: true,
    action: options.retry ? { label: "Retry", onClick: options.retry } : undefined,
  })
}

/** Run a user-initiated action with the standard loading → success/failure notifications. */
export async function runWithOperationToast<T>(id: string, copy: OperationToastCopy, action: () => Promise<T>, options: OperationToastOptions = {}): Promise<T | undefined> {
  showOperationLoading(id, copy.loading, copy.description)
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
