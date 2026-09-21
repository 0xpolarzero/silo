import { z } from "zod"

export const linuxDesktopStateSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullish(),
  state: z.enum(["running", "starting", "stopped", "failed", "uninstalled", "vm-stopped"]),
  autoStart: z.boolean(),
  ludaState: z.enum(["missing", "installing", "ready", "failed"]).optional(),
  ludaVersion: z.string().nullish(),
  port: z.number().nullish(),
  user: z.string().nullish(),
  display: z.string().nullish(),
})
export type LinuxDesktopState = z.infer<typeof linuxDesktopStateSchema>
export type DesktopAction = "start" | "stop" | "restart" | "setup-tools"

export function desktopViewerRoute() {
  const query = new URLSearchParams(window.location.search)
  const workspace = query.get("desktop")
  return workspace ? { workspace, name: query.get("name") ?? workspace } : null
}
