import { Activity, Bell, Boxes, CircleAlert, Code, File, GitFork, KeyRound, Monitor, Network, Play, RotateCw, Settings2, Square, Terminal, Upload, type LucideIcon } from "lucide-react"

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
  run: () => void
}

const workspaceSections = [
  { section: "files", label: "Files", icon: File, keywords: ["folders", "repositories"] },
  { section: "logs", label: "Logs", icon: Terminal, keywords: ["diagnostics", "output"] },
  { section: "network", label: "Network", icon: Network, keywords: ["ports", "connections"] },
  { section: "activity", label: "Activity", icon: Activity, keywords: ["history", "events"] },
] as const

export function applicationCommands(source: ApplicationSource, actions: ApplicationActions, navigate: (route: ApplicationInitialRoute) => void, onImportSandbox?: () => void): ApplicationCommand[] {
  // Lifecycle commands use the same guard as the pages: unavailable operations are reported,
  // and a request that needs a prompt asks it inside the palette.
  const guard = lifecycleGuard(source, actions)
  const destinations: { label: string; icon: LucideIcon; route: ApplicationInitialRoute; keywords?: string[] }[] = [
    { label: "Sandboxes", icon: Boxes, route: { workspaceSection: "overview" }, keywords: ["overview", "workspaces", "machines"] },
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
    for (const { section, label, icon, keywords } of workspaceSections) {
      commands.push({
        id: `${id}:${section}`, label: `Open ${name} ${label.toLowerCase()}`, icon, group: "Sandboxes",
        keywords: [...sandboxKeywords, ...keywords], run: () => navigate({ workspace: id, workspaceSection: section }),
      })
    }
    if (availability.canOpen) {
      commands.push(
        { id: `${id}:terminal`, label: `Open ${name} in ${source.preferences.terminal}`, icon: Terminal, group: "Actions", keywords: [...sandboxKeywords, "terminal", "shell"], run: () => actions.openTerminal(target) },
        { id: `${id}:editor`, label: `Open ${name} in ${source.preferences.editor}`, icon: Code, group: "Actions", keywords: [...sandboxKeywords, "editor", "code"], run: () => actions.openEditor(target) },
      )
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
