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
  const removeSecret = useCallback((id: string) => {
    setSecrets((current) => current.filter((secret) => secret.id !== id))
  }, [])

  const createCheckpoint = useCallback(async (target: string, name: string) => {
    setWorkspaces((current) => current.map((workspace) => workspace.machine.kind === "vm" && workspace.machine.name === target
      ? { ...workspace, checkpoints: [...(workspace.checkpoints ?? []), { id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), scope: workspace.state === "running" ? "full" : "disk", reason: "manual" }] }
      : workspace))
  }, [])
  const forkCheckpoint = useCallback(async (_target: string, _checkpointId: string | null, newName: string) => {
    onRestoreComplete(newName)
  }, [onRestoreComplete])
  const restoreCheckpoint = useCallback(async (target: string, checkpointId: string) => {
    setWorkspaces((current) => current.map((workspace) => workspace.machine.kind === "vm" && workspace.machine.name === target
      ? { ...workspace, state: "stopped", stateDetail: "Restored from checkpoint", checkpoints: (workspace.checkpoints ?? []).some((point) => point.id === checkpointId && point.reason === "before-restore") ? workspace.checkpoints : [...(workspace.checkpoints ?? []), { id: crypto.randomUUID(), name: "Before restore", createdAt: new Date().toISOString(), scope: "full", reason: "before-restore" }] }
      : workspace))
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

  return { source: { ...source, workspaces, secrets }, saveSecret, removeSecret, onRestoreComplete, createCheckpoint, forkCheckpoint, restoreCheckpoint }
}
