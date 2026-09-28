import { z } from "zod"

const desktopSessionStateSchema = z.enum(["stopped", "starting", "running", "failed"])

export const linuxDesktopStateSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullish(),
  streamerVersion: z.string().nullish(),
  state: z.enum(["running", "starting", "stopped", "failed", "uninstalled", "vm-stopped"]),
  autoStart: z.boolean(),
  backend: z.enum(["kasm", "selkies"]).nullish(),
  sessionState: desktopSessionStateSchema.nullish(),
  streamState: desktopSessionStateSchema.nullish(),
  updateRequired: z.boolean().nullish(),
  ludaState: z.enum(["missing", "installing", "ready", "failed"]).nullish(),
  ludaVersion: z.string().nullish(),
  lcuState: z.enum(["needs-runtime", "not-installed", "installing", "repair-required", "failed", "ready"]).nullish(),
  lcuReason: z.string().nullish(),
  lcuVersion: z.string().nullish(),
  lcuAppVersion: z.string().nullish(),
  lcuRuntimeVersion: z.string().nullish(),
  lcuAgents: z.array(z.string()).nullish(),
  lcuReadiness: z.enum(["ready", "unverified"]).nullish(),
  port: z.number().nullish(),
  user: z.string().nullish(),
  display: z.string().nullish(),
})
export type LinuxDesktopState = z.infer<typeof linuxDesktopStateSchema>
export type DesktopAction = "start" | "stop" | "restart" | "setup-tools" | "setup-lcu" | "restart-streamer" | "update-streamer"

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
