import { useCallback, useState } from "react"

import type { ApplicationSecret, ApplicationSource, SecretConfigurationRequest } from "@/features/application/model/application-source"

export function useApplicationFixture(source: ApplicationSource) {
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(source.workspaces)
  const [workspaces, setWorkspaces] = useState(source.workspaces)
  // Native status snapshots clone the source; only changed metadata resets local edits.
  const incomingSecrets = JSON.stringify(source.secrets)
  const [secretSnapshot, setSecretSnapshot] = useState(incomingSecrets)
  const [secrets, setSecrets] = useState(source.secrets)

  if (workspaceSnapshot !== source.workspaces) {
    setWorkspaceSnapshot(source.workspaces)
    setWorkspaces(source.workspaces)
  }
  if (secretSnapshot !== incomingSecrets) {
    setSecretSnapshot(incomingSecrets)
    setSecrets(source.secrets)
  }

  const onRestoreComplete = useCallback((targetName: string) => {
    setWorkspaces((current) => {
      const sourceWorkspace = current.find(({ machine }) => machine.kind === "vm")
      if (!sourceWorkspace || sourceWorkspace.machine.kind !== "vm" || current.some(({ machine }) => machine.name === targetName)) return current
      return [...current, {
        ...sourceWorkspace,
        machine: { ...sourceWorkspace.machine, id: crypto.randomUUID(), name: targetName },
        state: "stopped",
        stateDetail: "Restored and verified",
        attention: undefined,
      }]
    })
  }, [])
  const onRestartRequired = useCallback((sandboxes: string[]) => {
    setWorkspaces((current) => current.map((workspace) => workspace.machine.kind === "vm" && sandboxes.includes(workspace.machine.name)
      ? { ...workspace, state: "stopped", stateDetail: "Stopped after backup" }
      : workspace))
  }, [])
  const removeSecret = useCallback((id: string) => {
    setSecrets((current) => current.filter((secret) => secret.id !== id))
  }, [])

  const saveSecret = useCallback((request: SecretConfigurationRequest) => {
    // The preview retains metadata only; entered values are deliberately discarded.
    const secret: ApplicationSecret = {
      id: request.operation === "edit" ? request.id : crypto.randomUUID(),
      name: request.name,
      workspaces: request.workspaces,
      allowedDomains: request.allowedDomains,
      state: "restart-required",
    }
    setSecrets((current) => request.operation === "edit"
      ? current.map((existing) => existing.id === request.id ? secret : existing)
      : [...current, secret])
  }, [])

  return { source: { ...source, workspaces, secrets }, saveSecret, removeSecret, onRestoreComplete, onRestartRequired }
}
