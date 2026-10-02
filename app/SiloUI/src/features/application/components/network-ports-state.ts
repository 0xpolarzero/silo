import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { bridgeErrorMessage } from "@/contracts/bridge-error"
import { errorMessage, showActionFailure, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import type { ApplicationActions, ApplicationWorkspace, NetworkPort, NetworkState } from "@/features/application/model/application-source"

/** Where a forwarded port is reached on this computer. Websites use their sandbox's own
 * `*.localhost` name when the backend supplies one, so browsers keep each sandbox's cookies
 * apart from other local services in every browser; plain TCP ports use 127.0.0.1. */
export function networkAddress(port: NetworkPort, host?: string | null) {
  if (port.hostPort === null) return null
  return port.scheme ? `${port.scheme}://${host ?? "127.0.0.1"}:${port.hostPort}` : `127.0.0.1:${port.hostPort}`
}

/** The same port at 127.0.0.1, for development servers that reject unfamiliar host names. */
export function networkLoopbackAddress(port: NetworkPort) {
  return networkAddress(port, null)
}

/** The human-readable state of a port, accounting for VM lifecycle and stale/failed discovery. */
export function networkPortState(workspace: ApplicationWorkspace, port: NetworkPort, error?: string | null) {
  if (workspace.freshness === "stale") return "Unknown"
  if (workspace.state === "starting") return workspace.stateDetail === "Stopping" ? "Sandbox stopping" : "Sandbox starting"
  if (workspace.state !== "running") return workspace.state === "failed" ? "Sandbox failed" : "Sandbox stopped"
  if (error) return "Unknown"
  return ({ reachable: "Reachable", waiting: "Waiting for service", unpublished: "Not forwarded", unknown: "Unknown" })[port.state]
}

interface PortOperationIdentity { computer?: { id: string; name: string }; sandboxId: string; displayName: string }

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
  const pending = useRef(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const refreshNetwork = actions.refreshNetwork
  const currentWorkspaces = useRef<ApplicationWorkspace[] | null>(workspaces)
  useLayoutEffect(() => {
    currentWorkspaces.current = workspaces
    return () => { currentWorkspaces.current = null }
  }, [workspaces])

  function hasCurrentSandbox(identity: PortOperationIdentity) {
    return currentWorkspaces.current?.some(workspace => workspace.machine.id === identity.sandboxId
      && workspace.computer?.id === identity.computer?.id && workspace.machine.name === identity.displayName)
  }
  const changedSandbox = "This sandbox changed or is no longer available. Open its current Ports section and try again."

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
  async function run(id: string, identity: PortOperationIdentity, copy: { loading: string; step?: string; success: string; failure: string }, operation: () => Promise<void>, onSuccess?: () => void): Promise<boolean> {
    if (pending.current) return false
    if (!hasCurrentSandbox(identity)) {
      showOperationFailure(id, copy.failure, { description: changedSandbox, native: false })
      return false
    }
    pending.current = true
    setBusy(true)
    const sandbox = identity.displayName
    const location = identity.computer ? `${sandbox} · ${identity.computer.name}` : sandbox
    const noticeSandbox = { id: identity.sandboxId, name: sandbox }
    showOperationProgress(id, { title: `${copy.loading} · ${location}`, step: `${copy.step ?? copy.loading} · ${location}`, progress: null, sandbox })
    try {
      await operation()
      showOperationSuccess(id, `${copy.success} · ${location}`, { sandbox, noticeSandbox })
      setConfirm(null)
      onSuccess?.()
      return true
    } catch (cause) {
      const message = bridgeErrorMessage(cause) ?? (typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "The port could not be updated.")
      showOperationFailure(id, `${copy.failure} · ${location}`, { description: message, retry: () => void run(id, identity, copy, operation, onSuccess), sandbox, noticeSandbox })
      return false
    } finally { pending.current = false; setBusy(false) }
  }

  /** Opening is instant, so it has no loading phase: a failure stays until closed, with Retry. */
  async function open(workspace: ApplicationWorkspace, port: number) {
    const location = workspace.computer ? `${workspace.machine.name} · ${workspace.computer.name}` : workspace.machine.name
    const attempt = async () => {
      if (!hasCurrentSandbox({ computer: workspace.computer, sandboxId: workspace.machine.id, displayName: workspace.machine.name })) {
        showActionFailure(`Could not open port ${port} · ${location}`, changedSandbox, undefined, { id: `network-port-open:${workspace.machine.id}:${port}`, native: false })
        return
      }
      try { await actions.openNetworkPort!(workspaceTarget(workspace), port) }
      catch (cause) { showActionFailure(`Could not open port ${port} · ${location}`, typeof cause === "string" ? cause : errorMessage(cause), () => void attempt(), { id: `network-port-open:${workspace.machine.id}:${port}`, noticeSandbox: { id: workspace.machine.id, name: workspace.machine.name } }) }
    }
    await attempt()
  }

  const localWorkspaces = workspaces.filter(workspace => workspace.machine.kind === "vm")
  const loading = Boolean(refreshNetwork) && localWorkspaces.some(workspace => !network?.workspaces.some(item => item.workspace === workspaceTarget(workspace)))
  const rows = workspaces.flatMap(workspace => {
    const item = network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))
    return (item?.ports ?? []).map(port => ({ workspace, port, host: item?.host ?? null, error: item?.error ?? (workspace.computer ? null : error) }))
  })
    .sort((a, b) => a.workspace.machine.name.localeCompare(b.workspace.machine.name) || a.port.port - b.port.port)
  const errors = workspaces.flatMap(workspace => {
    const item = network?.workspaces.find(item => item.workspace === workspaceTarget(workspace))
    // A stopped sandbox has no live services to observe; its saved ports show as "Sandbox stopped".
    const ambiguous = workspaces.some(other => other !== workspace && other.machine.name === workspace.machine.name)
    const name = ambiguous ? `${workspace.machine.name} (${workspace.computer?.name ?? "This computer"})` : workspace.machine.name
    return item?.error && workspace.state !== "stopped" ? [`${name}: ${item.error}`] : []
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
    error: workspaces.some(workspace => !workspace.computer) ? error : null, draft, setDraft, fieldErrors, setFieldErrors, connecting, setConnecting, busy,
    /** Always null: operation failures are shown as notifications, not rendered inline. */
    confirm, setConfirm,
    run, open, add, startEdit, cancelDraft, loading, localWorkspaces, runningLocalWorkspaces, addDisabledReason, rows, errors, actions,
  }
}

export type NetworkPortsController = ReturnType<typeof useNetworkPorts>
