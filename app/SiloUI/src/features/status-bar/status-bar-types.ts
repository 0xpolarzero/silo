import type { ApplicationActions, ApplicationSource, ApplicationTab, ApplicationComputer, ComputerDetailTab, ComputerSection } from "@/features/application/model/application-source"

/** A renderer of one computer's "…" menu (see `computer-menu-items.ts`). */
export interface ComputerMenuProps {
  computer: ApplicationComputer
  source: ApplicationSource
  actions: StatusBarActions
  onFolders: () => void
  onConfirm: (action: "stop" | "restart") => void
}

export interface StatusBarRoute {
  tab?: ApplicationTab
  computerSection?: ComputerSection
  computer?: string
  computerTab?: ComputerDetailTab
}

export interface StatusBarActions extends Pick<ApplicationActions, "startComputer" | "stopComputer" | "restartComputer" | "openTerminal" | "pushRepository" | "listComputerDirectory"> {
  openSilo: (route?: StatusBarRoute) => void
  quit: () => void
  refresh: () => void
  openEditor: (computer: string, path: string) => void
  openSite: (computer: string, port: number) => void
  dismissRepositoryPush: (computer: string, repositoryPath: string) => void
}
