import { useEffect, useState, type ReactNode } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

/** Keep the existing screen visible while the native owner finishes Quit. */
export function ShutdownBoundary({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const [quitting, setQuitting] = useState(false)
  useEffect(() => {
    let disposed = false
    let receivedEvent = false
    let unsubscribe: (() => void) | undefined
    void listen<boolean>("silo://shutdown-state-changed", ({ payload }) => {
      receivedEvent = true
      if (!disposed && typeof payload === "boolean") setQuitting(payload)
    }).then(async stop => {
      if (disposed) { stop(); return }
      unsubscribe = stop
      const active = await invoke<boolean>("read_shutdown_state")
      if (!disposed && !receivedEvent && typeof active === "boolean") setQuitting(active)
    }).catch(error => console.error("Silo shutdown status:", error))
    return () => { disposed = true; unsubscribe?.() }
  }, [])
  return <div className={compact ? "flex min-h-0 flex-col" : "flex h-full min-h-0 flex-col"}>
    {quitting && <div role="status" className="border-b bg-muted px-4 py-2 text-xs">Stopping local VMs…</div>}
    <div className="flex min-h-0 flex-1 flex-col" inert={quitting} aria-busy={quitting}>{children}</div>
  </div>
}
