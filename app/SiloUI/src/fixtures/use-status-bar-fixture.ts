import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { ApplicationSource, RepositoryPushOperation } from "@/features/application/model/application-source"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"
import type { StatusBarActions, StatusBarRoute } from "@/features/status-bar/status-bar-types"
import { statusBarSourceForFixture, type StatusBarFixtureMode } from "./status-bar-scenarios"
import { useSettings } from "@/features/preferences/settings-store"

import { fixtureDirectoryLoader } from "./directory-loader"

interface PreviewOperation {
  name: string
  state: "running" | "stopped"
  action: "started" | "stopped" | "restarted"
  title: string
  occurredAt: string
}

function completeOperation(source: ApplicationSource, operation: PreviewOperation): ApplicationSource {
  return {
    ...source,
    workspaces: source.workspaces.map((workspace) => workspace.machine.name === operation.name ? {
      ...workspace,
      state: operation.state,
      stateDetail: operation.state === "running" ? "Running" : "Stopped",
      attention: undefined,
      freshness: "fresh",
      ports: workspace.ports.map((port, index) => ({ ...port, listening: operation.state === "running" && index === 0 })),
    } : workspace),
  }
}

function completePush(source: ApplicationSource, operation: RepositoryPushOperation): ApplicationSource {
  return {
    ...source,
    workspaces: source.workspaces.map((workspace) => workspace.machine.name === operation.workspace ? {
      ...workspace,
      repositories: workspace.repositories.map((repository) => repository.path === operation.repositoryPath ? {
        ...repository,
        ahead: Math.max(0, repository.ahead - operation.commitCount),
      } : repository),
    } : workspace),
    repositoryPushOperations: source.repositoryPushOperations.map((current) => current.workspace === operation.workspace && current.repositoryPath === operation.repositoryPath
      ? { ...operation, status: "succeeded" }
      : current),
  }
}

export function useStatusBarFixture(source: ApplicationSource, mode: StatusBarFixtureMode | undefined, onOpenSilo: (source: ApplicationSource, route?: StatusBarRoute) => void) {
  const { settings } = useSettings(source.preferences)
  const [settledSnapshot, setSnapshot] = useState(() => statusBarSourceForFixture(source, mode))
  const [pendingOperations, setPendingOperations] = useState<PreviewOperation[]>([])
  const operationTimers = useRef(new Map<string, number>())
  const pendingPushes = useRef(new Map<string, { operation: RepositoryPushOperation; timer: number }>())
  const [launched, setLaunched] = useState(true)
  const [acknowledgement, setAcknowledgement] = useState("")
  const snapshot: ApplicationSource = {
    ...settledSnapshot,
    preferences: { ...settledSnapshot.preferences, ...settings },
    workspaces: settledSnapshot.workspaces.map((workspace) => {
      const pending = pendingOperations.find(({ name }) => name === workspace.machine.name)
      return pending ? { ...workspace, state: pending.action === "stopped" ? workspace.state : "starting", stateDetail: pending.title } : workspace
    }),
    activities: [
      ...pendingOperations.map((operation) => ({
        id: `preview-${operation.name}`,
        workspace: operation.name,
        category: "sandbox" as const,
        status: "running" as const,
        tone: "neutral" as const,
        title: operation.title,
        detail: "",
        occurredAt: operation.occurredAt,
        time: "Now",
      })),
      ...source.activities,
    ],
  }

  useEffect(() => {
    const timers = operationTimers.current
    const pushes = pendingPushes.current
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
      pushes.forEach(({ timer }) => window.clearTimeout(timer))
      pushes.clear()
    }
  }, [])

  function updateWorkspace(name: string, state: PreviewOperation["state"], action: PreviewOperation["action"]) {
    if (operationTimers.current.has(name)) return
    const title = `${action === "started" ? "Starting" : action === "stopped" ? "Stopping" : "Restarting"} ${name}…`
    const operation = { name, state, action, title, occurredAt: new Date().toISOString() }
    setPendingOperations((current) => [...current, operation])
    setAcknowledgement("")
    operationTimers.current.set(name, window.setTimeout(() => {
      setSnapshot((current) => completeOperation(current, operation))
      setPendingOperations((current) => current.filter((pending) => pending.name !== name))
      operationTimers.current.delete(name)
      setAcknowledgement(`Preview: ${name} ${action}.`)
    }, 900))
  }

  function settleOperations() {
    let next = pendingOperations.reduce(completeOperation, { ...settledSnapshot, preferences: { ...settledSnapshot.preferences, ...settings }, activities: source.activities })
    pendingPushes.current.forEach(({ operation, timer }) => {
      window.clearTimeout(timer)
      next = completePush(next, operation)
    })
    pendingPushes.current.clear()
    operationTimers.current.forEach((timer) => window.clearTimeout(timer))
    operationTimers.current.clear()
    setPendingOperations([])
    setSnapshot(next)
    return next
  }

  function pushRepository(name: string, repositoryPath: string) {
    const key = JSON.stringify([name, repositoryPath])
    if (pendingPushes.current.has(key)) return
    const workspace = snapshot.workspaces.find(({ machine }) => machine.name === name)
    const repository = workspace?.repositories.find(({ path }) => path === repositoryPath)
    if (!workspace || !repository || repository.ahead <= 0 || !workspaceAvailability(workspace, snapshot).canOpen) return
    if (snapshot.repositoryPushOperations.some((operation) => operation.workspace === name && operation.repositoryPath === repositoryPath && operation.status === "pushing")) return
    const operation: RepositoryPushOperation = { workspace: name, repositoryPath, commitCount: repository.ahead, status: "pushing" }
    setSnapshot((current) => ({
      ...current,
      repositoryPushOperations: [
        ...current.repositoryPushOperations.filter((pending) => pending.workspace !== name || pending.repositoryPath !== repositoryPath),
        operation,
      ],
    }))
    const timer = window.setTimeout(() => {
      setSnapshot((current) => completePush(current, operation))
      pendingPushes.current.delete(key)
    }, 900)
    pendingPushes.current.set(key, { operation, timer })
  }

  const dismissRepositoryPush = useCallback((workspace: string, repositoryPath: string) => {
    setSnapshot((current) => ({
      ...current,
      repositoryPushOperations: current.repositoryPushOperations.filter((operation) => operation.workspace !== workspace || operation.repositoryPath !== repositoryPath || operation.status !== "succeeded"),
    }))
  }, [])

  const listWorkspaceDirectory = useMemo(() => fixtureDirectoryLoader(snapshot.workspaces), [snapshot.workspaces])
  const actions: StatusBarActions = {
    listWorkspaceDirectory,
    openSilo: (route) => onOpenSilo(settleOperations(), route),
    quit: () => {
      settleOperations()
      setLaunched(false)
      setAcknowledgement("Silo quit in this preview.")
    },
    refresh: () => {
      setSnapshot((current) => ({ ...current, workspaces: current.workspaces.map((workspace) => ({ ...workspace, freshness: "fresh" })) }))
      setAcknowledgement("Preview: sandbox status refreshed.")
    },
    startWorkspace: (name) => updateWorkspace(name, "running", "started"),
    stopWorkspace: (name) => updateWorkspace(name, "stopped", "stopped"),
    restartWorkspace: (name) => updateWorkspace(name, "running", "restarted"),
    openTerminal: (name) => setAcknowledgement(`Preview: open ${snapshot.preferences.terminal} in ${name}.`),
    openEditor: (name, path) => setAcknowledgement(`Preview: open ${path} in ${snapshot.preferences.editor} on ${name}.`),
    openSite: (name, port) => setAcknowledgement(`Preview: open ${name} port ${port} in ${snapshot.preferences.browser}.`),
    pushRepository,
    dismissRepositoryPush,
  }

  return { source: snapshot, actions, launched, acknowledgement, relaunch: () => { setLaunched(true); setAcknowledgement("") } }
}
