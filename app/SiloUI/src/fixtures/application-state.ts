import { useCallback, useState } from "react"

import type { ApplicationSource } from "@/features/application/model/application-source"

export function useApplicationFixture(source: ApplicationSource) {
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(source.workspaces)
  const [workspaces, setWorkspaces] = useState(source.workspaces)
  const [secretSnapshot, setSecretSnapshot] = useState(source.secrets)
  const [secrets, setSecrets] = useState(source.secrets)

  if (workspaceSnapshot !== source.workspaces) {
    setWorkspaceSnapshot(source.workspaces)
    setWorkspaces(source.workspaces)
  }
  if (secretSnapshot !== source.secrets) {
    setSecretSnapshot(source.secrets)
    setSecrets(source.secrets)
  }

  const onRestoreComplete = useCallback(() => {
    setWorkspaces((current) => current.map((workspace) => workspace.machine.kind === "vm"
      ? { ...workspace, state: "stopped", stateDetail: "Stopped after restore" }
      : workspace))
  }, [])
  const onRestartRequired = useCallback((sandboxes: string[]) => {
    setWorkspaces((current) => current.map((workspace) => workspace.machine.kind === "vm" && sandboxes.includes(workspace.machine.name)
      ? { ...workspace, state: "stopped", stateDetail: "Stopped after backup" }
      : workspace))
  }, [])
  const removeSecret = useCallback((id: string) => {
    setSecrets((current) => current.filter((secret) => secret.id !== id))
  }, [])

  return { source: { ...source, workspaces, secrets }, removeSecret, onRestoreComplete, onRestartRequired }
}
