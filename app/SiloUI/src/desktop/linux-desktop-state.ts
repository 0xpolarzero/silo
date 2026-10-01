import { z } from "zod"

const desktopSessionStateSchema = z.enum(["stopped", "starting", "running", "failed"])

export const linuxDesktopStateSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullish().catch(null),
  streamerVersion: z.string().nullish().catch(null),
  state: z.enum(["running", "starting", "stopped", "failed", "uninstalled", "vm-stopped"]),
  autoStart: z.boolean(),
  backend: z.enum(["kasm", "selkies"]).nullish(),
  sessionState: desktopSessionStateSchema.nullish(),
  streamState: desktopSessionStateSchema.nullish(),
  updateRequired: z.boolean().nullish(),
  lcuState: z.enum(["needs-runtime", "not-installed", "installing", "repair-required", "failed", "ready"]).nullish(),
  lcuReason: z.string().nullish().catch(null),
  lcuVersion: z.string().nullish().catch(null),
  lcuAppVersion: z.string().nullish().catch(null),
  lcuRuntimeVersion: z.string().nullish().catch(null),
  lcuAgents: z.array(z.string()).nullish().catch(null),
  // Diagnostic fields must never make the whole desktop state unreadable.
  lcuReadiness: z.enum(["ready", "unverified", "failed"]).nullish().catch(null),
  port: z.number().nullish().catch(null),
  user: z.string().nullish().catch(null),
  display: z.string().nullish().catch(null),
})
export type LinuxDesktopState = z.infer<typeof linuxDesktopStateSchema>
export type DesktopAction = "start" | "stop" | "restart" | "setup-lcu" | "restart-streamer" | "update-streamer"

export function parseLinuxDesktopState(value: unknown): LinuxDesktopState {
  const status = linuxDesktopStateSchema.parse(value)
  // New guests report the X session separately from its streamer. Preserve
  // legacy special states while deriving desktop health from the X session.
  return {
    ...status,
    state: status.state === "uninstalled" || status.state === "vm-stopped"
      ? status.state
      : status.sessionState ?? status.state,
  }
}

export function desktopViewerRoute() {
  const query = new URLSearchParams(window.location.search)
  const workspace = query.get("desktop")
  return workspace ? { workspace, name: query.get("name") ?? workspace } : null
}
