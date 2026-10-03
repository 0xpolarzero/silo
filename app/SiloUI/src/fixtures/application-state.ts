import { useCallback, useEffect, useRef, useState } from "react"

import type { ApplicationSecret, ApplicationSource, ApplicationWorkspace, SecretConfigurationRequest } from "@/features/application/model/application-source"
import type { WorkspaceCheckpoint } from "@/features/application/model/checkpoint-source"
import { remoteWorkspaceTarget, workspaceTarget } from "@/features/application/model/connections"

function fixtureCheckpoint(workspace: ApplicationWorkspace, name: string, reason: WorkspaceCheckpoint["reason"]): WorkspaceCheckpoint {
  return { id: `c${crypto.randomUUID().replaceAll("-", "").slice(0, 31)}`, name, createdAt: new Date().toISOString(), scope: workspace.pendingCheckpointRestore?.state ?? (workspace.state === "running" ? "full" : "disk"), reason }
}

function pendingWorkspace(workspace: ApplicationWorkspace): ApplicationWorkspace {
  return {
    machine: workspace.machine, device: workspace.device, purpose: "Local MicroSandbox",
    state: "stopped", stateDetail: "Ready to start from checkpoint", freshness: "fresh", settling: false,
    canDismissError: false, host: workspace.device ? workspace.host : "127.0.0.1",
    repositories: [], files: [], ports: [], logs: [], githubRepositories: workspace.githubRepositories,
    secretNames: workspace.secretNames, pendingSecretRevocations: [], checkpoints: [],
    checkpointOperation: null, unfinishedRestore: null,
  }
}

export function useApplicationFixture(source: ApplicationSource) {
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(source.workspaces)
  const [workspaces, setWorkspaces] = useState(source.workspaces)
  const checkpointMembers = useRef(new Map<string, string>())
  useEffect(() => { checkpointMembers.current.clear() }, [source.workspaces])
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
    const label = name.trim()
    const characters = [...label]
    if (!label || characters.length > 80 || characters.some((character) => {
      const code = character.codePointAt(0)!
      return code < 32 || (code >= 127 && code <= 159)
    })) throw "Checkpoint name must contain 1 to 80 printable characters."
    const selected = workspaces.find((workspace) => workspaceTarget(workspace) === target && workspace.machine.kind === "vm")
    if (!selected) throw "This workspace is not a local VM."
    const point = fixtureCheckpoint(selected, label, "manual")
    if (selected.pendingCheckpointRestore) checkpointMembers.current.set(point.id, selected.pendingCheckpointRestore.checkpointId)
    setWorkspaces((current) => current.map((workspace) => workspaceTarget(workspace) === target
      ? { ...workspace, checkpoints: [point, ...(workspace.checkpoints ?? [])], checkpointOperation: null }
      : workspace))
  }, [workspaces])
  const forkCheckpoint = useCallback(async (target: string, checkpointId: string | null, newName: string) => {
    const selected = workspaces.find((workspace) => workspaceTarget(workspace) === target)
    if (!selected || selected.machine.kind !== "vm") throw "The source workspace is not a local VM."
    if (workspaces.some((workspace) => workspace.device?.id === selected.device?.id && workspace.machine.name === newName)) throw "The fork name is already in use or the workspace limit was reached."
    const pending = checkpointId === null ? selected.pendingCheckpointRestore : undefined
    const captured = checkpointId === null && !pending ? fixtureCheckpoint(selected, "Fork point", "manual") : undefined
    const point = captured ?? selected.checkpoints?.find((checkpoint) => checkpoint.id === checkpointId)
    if (!pending && !point) throw "The selected checkpoint no longer exists."
    const id = crypto.randomUUID()
    const child: ApplicationWorkspace = {
      ...pendingWorkspace(selected),
      machine: { ...selected.machine, id: selected.device ? remoteWorkspaceTarget(selected.device.id, id) : id, name: newName },
      device: selected.device ? { ...selected.device, vmId: id } : undefined,
      pendingCheckpointRestore: pending ?? { checkpointId: checkpointMembers.current.get(point!.id) ?? point!.id, sourceWorkspace: selected.pendingCheckpointRestore?.sourceWorkspace ?? selected.machine.name, state: point!.scope },
    }
    setWorkspaces((current) => [...current.map((workspace) => workspaceTarget(workspace) === target && captured
      ? { ...workspace, checkpoints: [captured, ...(workspace.checkpoints ?? [])] }
      : workspace), child])
  }, [workspaces])
  const restoreCheckpoint = useCallback(async (target: string, checkpointId: string) => {
    const selected = workspaces.find((workspace) => workspaceTarget(workspace) === target && workspace.machine.kind === "vm")
    if (!selected) throw "This workspace is not a local VM."
    const point = selected.checkpoints?.find((checkpoint) => checkpoint.id === checkpointId)
    if (!point) throw "The selected checkpoint no longer exists."
    const recovery = fixtureCheckpoint(selected, "Before restore", "before-restore")
    if (selected.pendingCheckpointRestore) checkpointMembers.current.set(recovery.id, selected.pendingCheckpointRestore.checkpointId)
    setWorkspaces((current) => current.map((workspace) => workspaceTarget(workspace) === target
      ? { ...pendingWorkspace(workspace), checkpoints: [recovery, ...(workspace.checkpoints ?? [])], pendingCheckpointRestore: { checkpointId: checkpointMembers.current.get(point.id) ?? point.id, sourceWorkspace: workspace.pendingCheckpointRestore?.sourceWorkspace ?? workspace.machine.name, state: point.scope } }
      : workspace))
  }, [workspaces])

  const deleteCheckpoint = useCallback(async (target: string, checkpointId: string) => {
    setWorkspaces((current) => current.map((workspace) => workspace.machine.kind === "vm" && workspace.machine.name === target
      ? { ...workspace, checkpoints: (workspace.checkpoints ?? []).filter((point) => point.id !== checkpointId) }
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

  return { source: { ...source, workspaces, secrets }, saveSecret, removeSecret, onRestoreComplete, createCheckpoint, forkCheckpoint, restoreCheckpoint, deleteCheckpoint }
}
