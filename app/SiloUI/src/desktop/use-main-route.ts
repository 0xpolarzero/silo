import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { z } from "zod"
import type { StatusBarRoute } from "@/features/status-bar/status-bar-types"

const routeShape = z.object({
  tab: z.enum(["workspaces", "github", "secrets", "backup", "system", "settings"]).optional(),
  workspaceSection: z.enum(["overview", "files", "logs", "network", "activity"]).optional(),
  workspace: z.string().optional(),
}).strict()

export function useMainRoute(enabled: boolean) {
  const [route, setRoute] = useState<StatusBarRoute>()
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const receive = async () => {
      const parsed = routeShape.safeParse(await invoke("take_main_route"))
      if (!disposed && parsed.success) setRoute(parsed.data)
    }
    // Register before draining the pending request so opening during startup is reliable.
    void listen("desktop:route-requested", () => { void receive().catch(console.error) })
      .then(async stop => {
        if (disposed) { stop(); return }
        unlisten = stop
        await receive()
      }).catch(console.error)
    return () => { disposed = true; unlisten?.() }
  }, [enabled])
  return route
}
