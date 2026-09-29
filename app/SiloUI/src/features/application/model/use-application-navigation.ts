import { useCallback, useEffect, useState } from "react"

import type { ApplicationTab, SandboxDetailTab, SettingsSection, WorkspaceSection } from "./application-source"

interface Location {
  tab: ApplicationTab
  workspaceSection: WorkspaceSection
  settingsSection: SettingsSection
  /** The sandbox whose detail page is open in the Sandboxes overview, by machine id. */
  workspace?: string
  /** The active tab on that sandbox's detail page. */
  sandboxTab?: SandboxDetailTab
}

export type ApplicationInitialRoute = Partial<Location> & { workspace?: string }

interface History {
  entries: Location[]
  index: number
}

function sameDestination(left: Location, right: Location) {
  if (left.tab !== right.tab) return false
  if (left.tab === "settings") return left.settingsSection === right.settingsSection
  if (left.tab !== "workspaces") return true
  if (left.workspaceSection !== right.workspaceSection) return false
  // On the Sandboxes overview an open sandbox detail (and its tab) is its own destination.
  if (left.workspaceSection !== "overview") return true
  return (left.workspace ?? undefined) === (right.workspace ?? undefined)
    && (left.sandboxTab ?? undefined) === (right.sandboxTab ?? undefined)
}

function withoutSystemIssue(history: History): History {
  if (!history.entries.some(({ tab }) => tab === "system")) return history
  const entries: Location[] = []
  let index = 0
  history.entries.forEach((entry, position) => {
    if (entry.tab === "system" && position !== history.index) return
    const destination: Location = entry.tab === "system"
      ? { ...entry, tab: "workspaces", workspaceSection: "overview" }
      : entry
    if (!entries.length || !sameDestination(entries.at(-1)!, destination)) entries.push(destination)
    if (position <= history.index) index = entries.length - 1
  })
  return { entries, index }
}

export function useApplicationNavigation(hasSystemIssue: boolean, initialRoute?: ApplicationInitialRoute) {
  const [storedHistory, setHistory] = useState<History>({
    entries: [{
      tab: initialRoute?.tab ?? "workspaces",
      workspaceSection: initialRoute?.workspaceSection ?? "overview",
      settingsSection: initialRoute?.settingsSection ?? "general",
      // A deep link into the overview can preselect a sandbox detail page and tab.
      ...((initialRoute?.workspaceSection ?? "overview") === "overview" && initialRoute?.workspace
        ? { workspace: initialRoute.workspace, sandboxTab: initialRoute.sandboxTab ?? "overview" }
        : {}),
    }],
    index: 0,
  })
  const history = hasSystemIssue ? storedHistory : withoutSystemIssue(storedHistory)

  useEffect(() => {
    // A resolved issue is removed from history as well as the sidebar.
    // oxlint-disable-next-line react/set-state-in-effect
    if (!hasSystemIssue) setHistory(withoutSystemIssue)
  }, [hasSystemIssue])

  const navigate = useCallback((change: Partial<Location>) => {
    setHistory((stored) => {
      const current = hasSystemIssue ? stored : withoutSystemIssue(stored)
      const location = current.entries[current.index]
      const next = { ...location, ...change }
      if (sameDestination(location, next)) return current
      return { entries: [...current.entries.slice(0, current.index + 1), next], index: current.index + 1 }
    })
  }, [hasSystemIssue])

  const move = useCallback((offset: number) => {
    setHistory((stored) => {
      const current = hasSystemIssue ? stored : withoutSystemIssue(stored)
      const index = Math.max(0, Math.min(current.index + offset, current.entries.length - 1))
      return index === current.index ? current : { ...current, index }
    })
  }, [hasSystemIssue])

  return {
    ...history.entries[history.index],
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
    goBack: () => move(-1),
    goForward: () => move(1),
    selectTab: (tab: ApplicationTab) => navigate({ tab }),
    // Selecting a workspace section clears any open sandbox detail so the section shows plainly.
    selectWorkspaceSection: (workspaceSection: WorkspaceSection) => navigate({ tab: "workspaces", workspaceSection, workspace: undefined, sandboxTab: undefined }),
    selectSettingsSection: (settingsSection: SettingsSection) => navigate({ tab: "settings", settingsSection }),
    openSandbox: (workspace: string, sandboxTab: SandboxDetailTab = "overview") => navigate({ tab: "workspaces", workspaceSection: "overview", workspace, sandboxTab }),
    selectSandboxTab: (sandboxTab: SandboxDetailTab) => navigate({ tab: "workspaces", workspaceSection: "overview", sandboxTab }),
    closeSandbox: () => navigate({ tab: "workspaces", workspaceSection: "overview", workspace: undefined, sandboxTab: undefined }),
  }
}
