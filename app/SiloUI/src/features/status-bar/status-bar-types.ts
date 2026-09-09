import type { ApplicationActions, ApplicationTab, WorkspaceSection } from "@/features/application/model/application-source"

export interface StatusBarRoute {
  tab?: ApplicationTab
  workspaceSection?: WorkspaceSection
  workspace?: string
}

export interface StatusBarActions extends Pick<ApplicationActions, "startWorkspace" | "stopWorkspace" | "restartWorkspace" | "openTerminal" | "pushRepository" | "listWorkspaceDirectory"> {
  openSilo: (route?: StatusBarRoute) => void
  quit: () => void
  refresh: () => void
  openEditor: (workspace: string, path: string) => void
  openSite: (workspace: string, port: number) => void
  dismissRepositoryPush: (workspace: string, repositoryPath: string) => void
}
