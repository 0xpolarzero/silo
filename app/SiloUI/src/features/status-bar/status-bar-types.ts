import type { ApplicationActions, ApplicationSource, ApplicationTab, ApplicationWorkspace, SandboxDetailTab, WorkspaceSection } from "@/features/application/model/application-source"

/** A renderer of one sandbox's "…" menu (see `workspace-menu-items.ts`). */
export interface WorkspaceMenuProps {
  workspace: ApplicationWorkspace
  source: ApplicationSource
  actions: StatusBarActions
  onFolders: () => void
  onConfirm: (action: "stop" | "restart") => void
}

export interface StatusBarRoute {
  tab?: ApplicationTab
  workspaceSection?: WorkspaceSection
  workspace?: string
  sandboxTab?: SandboxDetailTab
}

export interface StatusBarActions extends Pick<ApplicationActions, "startWorkspace" | "stopWorkspace" | "restartWorkspace" | "openTerminal" | "pushRepository" | "listWorkspaceDirectory"> {
  openSilo: (route?: StatusBarRoute) => void
  quit: () => void
  refresh: () => void
  openEditor: (workspace: string, path: string) => void
  openSite: (workspace: string, port: number) => void
  dismissRepositoryPush: (workspace: string, repositoryPath: string) => void
}
