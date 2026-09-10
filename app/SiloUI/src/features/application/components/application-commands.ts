import { Activity, Bell, Boxes, CircleAlert, Code, File, GitFork, HardDrive, KeyRound, Monitor, Network, Play, RotateCw, Settings2, Square, Terminal, type LucideIcon } from "lucide-react"

import type { ApplicationActions, ApplicationSource } from "@/features/application/model/application-source"
import type { ApplicationInitialRoute } from "@/features/application/model/use-application-navigation"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"

export interface ApplicationCommand {
  id: string
  label: string
  group: "Go to" | "Sandboxes" | "Actions"
  icon: LucideIcon
  keywords?: string[]
  run: () => void
}

const workspaceSections = [
  { section: "files", label: "Files", icon: File, keywords: ["folders", "repositories"] },
  { section: "logs", label: "Logs", icon: Terminal, keywords: ["diagnostics", "output"] },
  { section: "network", label: "Network", icon: Network, keywords: ["ports", "connections"] },
  { section: "activity", label: "Activity", icon: Activity, keywords: ["history", "events"] },
] as const

export function applicationCommands(source: ApplicationSource, actions: ApplicationActions, navigate: (route: ApplicationInitialRoute) => void): ApplicationCommand[] {
  const destinations: { label: string; icon: LucideIcon; route: ApplicationInitialRoute; keywords?: string[] }[] = [
    { label: "Sandboxes", icon: Boxes, route: { workspaceSection: "overview" }, keywords: ["overview", "workspaces", "machines"] },
    ...workspaceSections.map(({ section, label, icon, keywords }) => ({ label, icon, route: { workspaceSection: section }, keywords: [...keywords] })),
    { label: "GitHub", icon: GitFork, route: { tab: "github" }, keywords: ["git", "account", "access"] },
    { label: "Secrets", icon: KeyRound, route: { tab: "secrets" }, keywords: ["tokens", "credentials"] },
    { label: "Backup", icon: HardDrive, route: { tab: "backup" }, keywords: ["archive", "restore"] },
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

  for (const workspace of source.workspaces) {
    const { id, name } = workspace.machine
    const availability = workspaceAvailability(workspace, source)
    for (const { section, label, icon, keywords } of workspaceSections) {
      commands.push({
        id: `${id}:${section}`, label: `Open ${name} ${label.toLowerCase()}`, icon, group: "Sandboxes",
        keywords: [name, ...keywords], run: () => navigate({ workspace: id, workspaceSection: section }),
      })
    }
    if (availability.canOpen) {
      commands.push(
        { id: `${id}:terminal`, label: `Open ${name} in ${source.preferences.terminal}`, icon: Terminal, group: "Actions", keywords: [name, "terminal", "shell"], run: () => actions.openTerminal(name) },
        { id: `${id}:editor`, label: `Open ${name} in ${source.preferences.editor}`, icon: Code, group: "Actions", keywords: [name, "editor", "code"], run: () => actions.openEditor(name) },
      )
    }
    const lifecycle = [
      { label: "Start", icon: Play, available: availability.canStart, run: actions.startWorkspace },
      { label: "Stop", icon: Square, available: availability.canStop, run: actions.stopWorkspace },
      { label: "Restart", icon: RotateCw, available: availability.canRestart, run: actions.restartWorkspace },
    ]
    for (const { label, icon, available, run } of lifecycle) {
      if (available) commands.push({
        id: `${id}:${label}`, label: `${label} ${name}`, icon, group: "Actions", keywords: ["sandbox", name],
        run: () => { navigate({ workspaceSection: "overview" }); run(name) },
      })
    }
  }
  return commands
}
