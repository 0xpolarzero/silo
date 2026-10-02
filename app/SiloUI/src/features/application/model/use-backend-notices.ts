import { useEffect } from "react"

import { listenForNotices, type Notice } from "@/desktop/notices"
import { showOperationFailure, showOperationSuccess } from "@/lib/operation-toast"

/**
 * Show the in-app toast for a backend-originated notice (an unexpected sandbox change, a
 * startup or update failure). The backend already sent the system notification, so nothing
 * here mirrors it back (`native: false`). The notice key is the toast id: a repeat replaces
 * the earlier toast in place, and a tagged sandbox ID lets deleting that sandbox clear it.
 */
export function showBackendNotice(notice: Notice) {
  const common = { description: notice.body || undefined, noticeSandbox: notice.sandbox ?? undefined, native: false }
  if (notice.category === "completions") showOperationSuccess(notice.key, notice.title, { ...common, persist: true })
  else showOperationFailure(notice.key, notice.title, { ...common, tone: notice.category === "changes" ? "warning" : "error" })
}

/** Subscribe to backend notices while mounted. A no-op outside the desktop app. */
export function useBackendNotices() {
  useEffect(() => listenForNotices(showBackendNotice), [])
}
