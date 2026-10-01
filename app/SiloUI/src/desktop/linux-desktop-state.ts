import { z } from "zod"

const desktopSessionStateSchema = z.enum(["stopped", "starting", "running", "failed"])

// Built-in computer use (v4 VMs). Every field tolerates a newer or malformed value,
// so a diagnostic detail can never make the desktop state unreadable.
export const computerUseStates = ["unavailable", "needs-consent", "preparing", "installing", "ready", "failed"] as const
export const computerUseSchema = z.object({
  state: z.enum(computerUseStates).catch("unavailable"),
  reason: z.string().nullish().catch(null),
  compatibility: z.enum(["tested", "untested", "unknown"]).catch("unknown"),
  warning: z.string().nullish().catch(null),
  approval: z.enum(["ask", "auto"]).catch("ask"),
  appVersion: z.string().nullish().catch(null),
  runtimeVersion: z.string().nullish().catch(null),
  lcuVersion: z.string().nullish().catch(null),
  agents: z.array(z.string()).nullish().catch(null),
})
export type ComputerUseState = z.infer<typeof computerUseSchema>
export type ComputerUseApproval = ComputerUseState["approval"]

// The official ChatGPT Linux app, downloaded once per computer after a notice.
export const chatGptAppStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("notConsented") }),
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("downloading"), receivedBytes: z.number().nonnegative().catch(0), totalBytes: z.number().nonnegative().nullish().catch(null) }),
  z.object({ state: z.literal("verifying") }),
  z.object({ state: z.literal("extracting") }),
  z.object({ state: z.literal("ready"), path: z.string().nullish().catch(null), version: z.string().nullish().catch(null) }),
  z.object({ state: z.literal("failed"), reason: z.string().catch("The download did not finish."), retryable: z.boolean().catch(false) }),
])
export type ChatGptAppStatus = z.infer<typeof chatGptAppStatusSchema>

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
  // Present only on v4 VMs, where the desktop is built in. Older VMs report the lcu* fields.
  computerUse: computerUseSchema.nullish().catch(null),
  lcuReadiness: z.enum(["ready", "unverified", "failed"]).nullish().catch(null),
  port: z.number().nullish().catch(null),
  user: z.string().nullish().catch(null),
  display: z.string().nullish().catch(null),
})
export type LinuxDesktopState = z.infer<typeof linuxDesktopStateSchema>
export type DesktopAction = "start" | "stop" | "restart" | "setup-lcu" | "setup-computer-use" | "restart-streamer" | "update-streamer"

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
