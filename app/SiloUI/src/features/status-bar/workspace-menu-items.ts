import type { ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"

/**
 * One sandbox's "…" menu in the status panel, as data. The desktop app renders it as a
 * native menu (`desktop/native-workspace-menu.tsx`); the browser preview renders the same
 * items with Radix (`workspace-menu.tsx`), so tests of either exercise what users see.
 */
export type WorkspaceMenuItem =
  | { kind: "action"; id: string; label: string; enabled: boolean; run: () => void }
  | { kind: "separator" }
  | { kind: "submenu"; id: string; label: string; enabled: boolean; items: WorkspaceMenuItem[] }
  /** Copies `value`; renderers report the result with these labels. */
  | { kind: "copy"; id: string; label: string; value: string; copied: string; failed: string }

export interface WorkspaceMenuHandlers {
  start: () => void
  /** Stop and Restart always ask first (decision 8), so they only request a confirmation. */
  confirm: (action: "stop" | "restart") => void
  openTerminal: () => void
  /** Opens the folder picker for the configured editor. */
  chooseFolder: () => void
  openSite: (port: number) => void
}

/** Sites that `open_network_port` accepts: configured, reachable, with a scheme and host port. */
export function workspaceSites(workspace: ApplicationWorkspace) {
  return workspace.ports
    .filter(({ listening, configured, scheme, hostPort }) => listening === true && configured === true && scheme != null && hostPort != null)
    .sort((a, b) => a.port - b.port)
}

export function workspaceMenuItems(workspace: ApplicationWorkspace, source: ApplicationSource, handlers: WorkspaceMenuHandlers): WorkspaceMenuItem[] {
  const { canOpen, canStart, canStop, canRestart } = workspaceAvailability(workspace, source)
  const sites = workspaceSites(workspace)
  return [
    ...(workspace.state === "stopped"
      ? [{ kind: "action", id: "start", label: "Start", enabled: canStart, run: handlers.start } as const]
      : [
        { kind: "action", id: "stop", label: "Stop…", enabled: canStop, run: () => handlers.confirm("stop") } as const,
        { kind: "action", id: "restart", label: "Restart…", enabled: canRestart, run: () => handlers.confirm("restart") } as const,
      ]),
    { kind: "separator" },
    { kind: "action", id: "terminal", label: `Open in ${source.preferences.terminal}`, enabled: canOpen, run: handlers.openTerminal },
    { kind: "action", id: "editor", label: `Open in ${source.preferences.editor}…`, enabled: canOpen, run: handlers.chooseFolder },
    {
      kind: "submenu",
      id: "sites",
      label: "Open site",
      enabled: canOpen,
      items: sites.length
        ? [
          ...sites.map(({ port }) => ({ kind: "action", id: `site:${port}`, label: `Port ${port}`, enabled: true, run: () => handlers.openSite(port) } as const)),
          { kind: "separator" } as const,
          ...sites.map(({ port, scheme, hostPort }) => ({
            kind: "copy",
            id: `copy:${port}`,
            label: `Copy port ${port} address`,
            value: `${scheme}://127.0.0.1:${hostPort}`,
            copied: `Port ${port} address copied`,
            failed: `Couldn't copy port ${port} address`,
          } as const)),
        ]
        : [{ kind: "action", id: "no-sites", label: "No active sites", enabled: false, run: () => {} }],
    },
  ]
}
