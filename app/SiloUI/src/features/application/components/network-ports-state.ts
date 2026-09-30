import { useEffect, useState } from "react"

import { errorMessage, showActionFailure, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import type { ApplicationActions, ApplicationWorkspace, NetworkPort, NetworkState } from "@/features/application/model/application-source"

/** Where a forwarded port is reached on this computer. Websites use their sandbox's own
 * `*.localhost` name when the backend supplies one, so browsers keep each sandbox's cookies
 * apart from other local services; plain TCP ports and other browsers use 127.0.0.1. */
export function networkAddress(port: NetworkPort, host?: string | null) {
  if (port.hostPort === null) return null
  return port.scheme ? `${port.scheme}://${host ?? "127.0.0.1"}:${port.hostPort}` : `127.0.0.1:${port.hostPort}`
}

/** The same port at 127.0.0.1, for development servers that reject unfamiliar host names. */
export function networkLoopbackAddress(port: NetworkPort) {
  return networkAddress(port, null)
}

/** The human-readable state of a port, accounting for VM lifecycle and stale/failed discovery. */
export function networkPortState(workspace: ApplicationWorkspace, port: NetworkPort, error?: string | null, errors: string[] = []) {
  if (workspace.state !== "running") return workspace.state === "starting" ? "VM starting" : workspace.state === "failed" ? "VM failed" : "VM stopped"
  if (workspace.freshness === "stale" || error || errors.some(e => e.startsWith(`${workspace.machine.name}:`))) return "Unknown"
  return ({ reachable: "Reachable", waiting: "Waiting for service", unpublished: "VM only", unknown: "Unknown" })[port.state]
}

interface PortDraft { workspace: string; port: string; hostPort: string; scheme: string; editing: boolean }

/** Shared state and operations for adding, editing, connecting, and removing forwarded ports.
 * Both the full Network page and a sandbox's Ports section drive identical behaviour from it. */
export function useNetworkPorts({ workspaces, network, error, actions, active }: {
  workspaces: ApplicationWorkspace[]
  network?: NetworkState
  error?: string | null
  actions: ApplicationActions
  active: boolean
}) {
  const [draft, setDraft] = useState<PortDraft | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ port?: string; hostPort?: string }>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const refreshNetwork = actions.refreshNetwork

  useEffect(() => {
    if (!active || !refreshNetwork) return
    const refresh = () => { if (document.visibilityState !== "hidden") void refreshNetwork() }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh) }
  }, [active, refreshNetwork])

  /** Runs a port operation with the shared loading → success/failure notifications. Failures offer Retry. */
  async function run(id: string, copy: { loading: string; step?: string; success: string; failure: string }, operation: () => Promise<void>, onSuccess?: () => void): Promise<boolean> {
    setBusy(true)
    // Ids read `network-port:<target>:…`; a local target is the sandbox name (see `workspaceTarget`).
    const sandbox = id.split(":")[1]
    const machine = workspaces.find(workspace => workspaceTarget(workspace) === sandbox)?.machine
    const noticeSandbox = machine ? { id: machine.id, name: machine.name } : undefined
    showOperationProgress(id, { title: copy.loading, step: copy.step ?? `${copy.loading}…`, progress: null, sandbox })
    try {
      await operation()
      showOperationSuccess(id, copy.success, { sandbox, noticeSandbox })
      setConfirm(null)
      onSuccess?.()
      return true
    } catch (cause) {
      const message = typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "The port could not be updated."
      showOperationFailure(id, copy.failure, { description: message, retry: () => void run(id, copy, operation, onSuccess), sandbox, noticeSandbox })
      return false
    } finally { setBusy(false) }
  }

  /** Opening is instant, so it has no loading phase: a failure stays until closed, with Retry. */
  async function open(workspace: string, port: number) {
    const attempt = async () => {
      try { await actions.openNetworkPort!(workspace, port) }
      catch (cause) { showActionFailure(`Could not open port ${port}`, typeof cause === "string" ? cause : errorMessage(cause), () => void attempt(), { noticeSandbox: (() => { const machine = workspaces.find(item => workspaceTarget(item) === workspace)?.machine; return machine ? { id: machine.id, name: machine.name } : undefined })() }) }
    }
    await attempt()
  }

  const localWorkspaces = workspaces.filter(workspace => workspace.machine.kind === "vm")
  const rows = workspaces.flatMap(workspace => {
    const item = network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))
    return (item?.ports ?? []).map(port => ({ workspace, port, host: item?.host ?? null }))
  })
    .sort((a, b) => a.workspace.machine.name.localeCompare(b.workspace.machine.name) || a.port.port - b.port.port)
  const errors = workspaces.flatMap(workspace => {
    const item = network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))
    // A stopped sandbox has no live services to observe; its saved ports show as "VM stopped".
    return item?.error && workspace.state !== "stopped" ? [`${workspace.machine.name}: ${item.error}`] : []
  })

  const runningLocalWorkspaces = localWorkspaces.filter(workspace => workspace.state === "running")
  /** Why "Add port" is unavailable, or null when it can be used. */
  const addDisabledReason = runningLocalWorkspaces.length > 0 ? null
    : localWorkspaces.length === 1 ? `Start ${localWorkspaces[0].machine.name} to add ports`
    : localWorkspaces.length > 1 ? "Start a sandbox to add ports" : null

  function add(workspace = runningLocalWorkspaces[0] ? workspaceTarget(runningLocalWorkspaces[0]) : "", port = "") {
    setFieldErrors({}); setDraft({ workspace, port, hostPort: "", scheme: "http", editing: false })
  }
  function startEdit(workspace: ApplicationWorkspace, port: NetworkPort) {
    setFieldErrors({})
    setDraft({ workspace: workspaceTarget(workspace), port: String(port.port), hostPort: port.configuredHostPort == null ? "" : String(port.configuredHostPort), scheme: port.scheme ?? "tcp", editing: true })
  }
  function cancelDraft() { setDraft(null) }

  return {
    error, draft, setDraft, fieldErrors, setFieldErrors, connecting, setConnecting, busy,
    /** Always null: operation failures are shown as notifications, not rendered inline. */
    confirm, setConfirm,
    run, open, add, startEdit, cancelDraft, localWorkspaces, runningLocalWorkspaces, addDisabledReason, rows, errors, actions,
  }
}

export type NetworkPortsController = ReturnType<typeof useNetworkPorts>
