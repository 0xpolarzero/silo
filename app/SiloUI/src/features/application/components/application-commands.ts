import { Activity, Bell, Boxes, CircleAlert, Code, Download, File, GitFork, History, KeyRound, Monitor, Network, Play, Plus, RotateCw, Settings2, Square, Terminal, Trash2, Upload, type LucideIcon } from "lucide-react"

import type { ApplicationActions, ApplicationSource } from "@/features/application/model/application-source"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"
import { lifecycleGuard, type LifecycleAction } from "@/features/application/model/lifecycle-guard"

/** A question the palette asks, in place, before running a command. */
export interface CommandConfirmation {
  title: string
  description: string
  confirmLabel: string
  tone: "default" | "destructive"
}

export interface ApplicationCommand {
  id: string
  label: string
  group: "Go to" | "Sandboxes" | "Actions"
  icon: LucideIcon
  keywords?: string[]
  /** Asked inside the palette first; `run` then proceeds as confirmed. */
  confirm?: CommandConfirmation
  /** The command opens a popover or picker in the window: closing the palette leaves focus to it. */
  opensPanel?: boolean
  run: () => void
}

/** What a palette command opens on a sandbox's page, in place of the page's own button. */
export type SandboxCommandRequest = "editor" | "fork" | "delete"

export interface ApplicationCommandOptions {
  onImportSandbox?: () => void
  onNewSandbox?: () => void
  onExportSandbox?: (sandboxName: string) => void
  /** Opens the sandbox's page and there its editor folder picker, Fork or Delete popover. */
  onSandboxRequest?: (workspaceId: string, request: SandboxCommandRequest) => void
}

const workspaceSections = [
  { section: "files", label: "Files", icon: File, keywords: ["folders", "repositories"] },
  { section: "logs", label: "Logs", icon: Terminal, keywords: ["diagnostics", "output"] },
  { section: "network", label: "Network", icon: Network, keywords: ["ports", "connections"] },
  { section: "activity", label: "Activity", icon: Activity, keywords: ["history", "events"] },
] as const

export function applicationCommands(source: ApplicationSource, actions: ApplicationActions, navigate: (route: ApplicationInitialRoute) => void, { onImportSandbox, onNewSandbox, onExportSandbox, onSandboxRequest }: ApplicationCommandOptions = {}): ApplicationCommand[] {
  // Lifecycle commands use the same guard as the pages: unavailable operations are reported,
  // and a request that needs a prompt asks it inside the palette.
  const guard = lifecycleGuard(source, actions)
  const destinations: { label: string; icon: LucideIcon; route: ApplicationInitialRoute; keywords?: string[] }[] = [
    { label: "All sandboxes", icon: Boxes, route: { workspaceSection: "overview" }, keywords: ["overview", "workspaces", "machines"] },
    ...workspaceSections.map(({ section, label, icon, keywords }) => ({ label, icon, route: { workspaceSection: section }, keywords: [...keywords] })),
    { label: "GitHub", icon: GitFork, route: { tab: "github" }, keywords: ["git", "account", "access"] },
    { label: "Secrets", icon: KeyRound, route: { tab: "secrets" }, keywords: ["tokens", "credentials"] },
    { label: "Settings", icon: Settings2, route: { settingsSection: "general" }, keywords: ["general", "preferences", "applications"] },
    { label: "Computers", icon: Monitor, route: { settingsSection: "computers" }, keywords: ["remote", "ssh", "connections", "management"] },
    { label: "Notifications", icon: Bell, route: { settingsSection: "notifications" }, keywords: ["alerts"] },
  ]
  if (source.runtimeRepair) {
    destinations.push({ label: "System issue", icon: CircleAlert, route: { tab: "system" }, keywords: ["checks", "runtime", "installation"] })
  }
  const commands: ApplicationCommand[] = destinations.map(({ label, icon, route, keywords }) => ({
    id: `page:${label}`, label, icon, keywords, group: "Go to", run: () => navigate(route),
  }))

  if (onNewSandbox) {
    commands.push({ id: "action:new-sandbox", label: "New sandbox…", icon: Plus, group: "Actions", keywords: ["create", "add", "vm"], run: onNewSandbox })
  }
  if (onImportSandbox) {
    commands.push({ id: "action:import-sandbox", label: "Import sandbox…", icon: Upload, group: "Actions", keywords: ["restore", "archive", "backup", "transfer"], run: onImportSandbox })
  }

  for (const workspace of source.workspaces) {
    const { id } = workspace.machine
    // Remote sandboxes are addressed by their computer target and named with their computer,
    // so a remote "dev" never resolves to (or reads like) a local "dev".
    const target = workspaceTarget(workspace)
    const name = workspace.computer ? `${workspace.machine.name} on ${workspace.computer.name}` : workspace.machine.name
    const sandboxKeywords = workspace.computer ? [workspace.machine.name, workspace.computer.name] : [name]
    const availability = workspaceAvailability(workspace, source)
    const vm = workspace.machine.kind === "vm"
    commands.push({ id: `${id}:page`, label: `Open ${name}`, icon: Boxes, group: "Sandboxes", keywords: [...sandboxKeywords, "sandbox", "details"], run: () => navigate({ workspace: id }) })
    if (vm) commands.push({ id: `${id}:checkpoints`, label: `Open ${name} checkpoints`, icon: History, group: "Sandboxes", keywords: [...sandboxKeywords, "checkpoints", "restore", "snapshot"], run: () => navigate({ workspace: id, sandboxTab: "checkpoints" }) })
    for (const { section, label, icon, keywords } of workspaceSections) {
      commands.push({
        id: `${id}:${section}`, label: `Open ${name} ${label.toLowerCase()}`, icon, group: "Sandboxes",
        keywords: [...sandboxKeywords, ...keywords], run: () => navigate({ workspace: id, workspaceSection: section }),
      })
    }
    if (availability.canOpen) {
      commands.push(
        { id: `${id}:terminal`, label: `Open ${name} in ${source.preferences.terminal}`, icon: Terminal, group: "Actions", keywords: [...sandboxKeywords, "terminal", "shell"], run: () => actions.openTerminal(target) },
        // Like the editor buttons, the command asks which folder to open first.
        onSandboxRequest
          ? { id: `${id}:editor`, label: `Open ${name} in ${source.preferences.editor}…`, icon: Code, group: "Actions", keywords: [...sandboxKeywords, "editor", "code", "folder"], opensPanel: true, run: () => onSandboxRequest(id, "editor") }
          : { id: `${id}:editor`, label: `Open ${name} in ${source.preferences.editor}`, icon: Code, group: "Actions", keywords: [...sandboxKeywords, "editor", "code"], run: () => actions.openEditor(target) },
      )
    }
    // Fork and Delete open the sandbox page's own popovers; they follow the page's ⋯ menu rules.
    const changing = source.sandboxConfigurationOperation !== null || availability.busy || workspace.freshness === "stale"
    if (vm && actions.forkCheckpoint && onSandboxRequest && !changing) {
      commands.push({ id: `${id}:fork`, label: `Fork ${name}…`, icon: GitFork, group: "Actions", keywords: [...sandboxKeywords, "fork", "copy", "clone"], opensPanel: true, run: () => onSandboxRequest(id, "fork") })
    }
    if (vm && !workspace.computer && onExportSandbox && !changing) {
      commands.push({ id: `${id}:export`, label: `Export ${name}…`, icon: Download, group: "Actions", keywords: [...sandboxKeywords, "export", "backup", "archive"], run: () => onExportSandbox(workspace.machine.name) })
    }
    const offline = Boolean(workspace.computer && !workspace.computer.connected)
    if (onSandboxRequest && source.sandboxConfigurationOperation === null && !availability.busy && !offline && !(vm && workspace.state === "running")) {
      commands.push({ id: `${id}:delete`, label: `Delete ${name}…`, icon: Trash2, group: "Actions", keywords: [...sandboxKeywords, "delete", "remove"], opensPanel: true, run: () => onSandboxRequest(id, "delete") })
    }
    const lifecycle: { action: LifecycleAction; label: string; icon: LucideIcon; available: boolean }[] = [
      { action: "start", label: "Start", icon: Play, available: availability.canStart },
      { action: "stop", label: "Stop", icon: Square, available: availability.canStop },
      { action: "restart", label: "Restart", icon: RotateCw, available: availability.canRestart },
    ]
    for (const { action, label, icon, available } of lifecycle) {
      if (!available) continue
      const check = guard.check(workspace, action)
      const confirm = check.kind === "confirm" ? check.prompt : undefined
      commands.push({
        id: `${id}:${label}`, label: `${label} ${name}${confirm ? "…" : ""}`, icon, group: "Actions", keywords: ["sandbox", ...sandboxKeywords], confirm,
        run: () => {
          navigate({ workspaceSection: "overview" })
          if (confirm) guard.confirm(workspace, action)
          else guard.request(workspace, action)
        },
      })
    }
  }
  return commands
}
