import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { BackupState } from "@/features/application/model/backup-source"
import { createProductionSource, parseApplicationSource, parseBackupState, type ProductionBridge } from "./production-source"
import { siloProgressEventSchema } from "@/contracts/silo"

const source = applicationSourceForScenario("running")
const backup: BackupState = {
  snapshotId: "one",
  availability: "available",
  requiredSpaceGB: 2,
  availableSpaceGB: 40,
  archives: [{ name: "dev.silo-backup", archivePath: "/tmp/dev.silo-backup", completedLabel: "Today", size: "1 GB", destination: "/tmp", sandboxes: ["dev"] }],
  operation: null,
}

function native(overrides: Partial<ProductionBridge> = {}) {
  let event: (() => void) | null = null
  const invoke = vi.fn(async (command: string, _arguments_?: Record<string, unknown>): Promise<unknown> => {
    if (command === "read_application_state") return structuredClone(source)
    if (command === "read_backup_state") return structuredClone(backup)
    if (command === "workspace_action" || command === "retry_workspace_start") return structuredClone(source)
    return undefined
  })
  const listen = vi.fn(async (_name: string, handler: () => void) => { event = handler; return () => { event = null } })
  return { bridge: { invoke, listen, ...overrides } as ProductionBridge, invoke, emit: () => event?.() }
}

describe("production application bridge", () => {
  it("refreshes repository rows while visible without overlapping slow reads and stops on disposal", async () => {
    vi.useFakeTimers()
    const mock = native()
    let complete: ((value: unknown) => void) | undefined
    let reads = 0
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_application_state") {
        reads++
        if (reads === 1) return structuredClone(source)
        return new Promise(resolve => { complete = resolve })
      }
      return mock.invoke(command, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    try {
      await store.initialize()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reads).toBe(2)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(reads).toBe(2)
      const changed = structuredClone(source)
      changed.workspaces[0].repositories = [{ path: "new-repository", branch: "main", ahead: 0, behind: 0, dirty: false }]
      complete!(changed)
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getSnapshot().source?.workspaces[0].repositories).toEqual(changed.workspaces[0].repositories)
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reads).toBe(2)
      visibility.mockRestore()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reads).toBe(3)
      complete!(changed)
      await vi.advanceTimersByTimeAsync(0)
      store.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reads).toBe(3)
    } finally {
      store.dispose()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it("bypasses local and remote repository caches for an explicit refresh", async () => {
    const mock = native()
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "remote_host_list") return [{ id: "office", name: "Office Mac", address: "user@office" }]
      if (command === "remote_host_snapshot") return structuredClone(source)
      return mock.invoke(command, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    try {
      await store.initialize()
      await store.applicationActions.refreshRepositories!()
      expect(invoke).toHaveBeenCalledWith("read_application_state", { refreshRepositories: true })
      expect(invoke).toHaveBeenCalledWith("remote_host_snapshot", { hostId: "office", refreshRepositories: true })
    } finally { store.dispose() }
  })

  it.each(["dev", "silo-remote:00000000-0000-4000-8000-000000000010:00000000-0000-4000-8000-000000000011"])("opens the desktop for the exact selected target %s", async workspace => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.applicationActions.openDesktop!(workspace)
    expect(mock.invoke).toHaveBeenCalledWith("open_desktop", { workspace })
    expect(mock.invoke.mock.calls.some(([command]) => command === "workspace_action")).toBe(false)
    store.dispose()
  })

  it("reports desktop opening failure without changing the sandbox state", async () => {
    const mock = native()
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "open_desktop") throw new Error("Owning computer unavailable")
      return mock.invoke(command, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    const before = store.getSnapshot().source?.workspaces
    await store.applicationActions.openDesktop!("dev")
    expect(store.getSnapshot().error).toContain("Owning computer unavailable")
    expect(store.getSnapshot().source?.workspaces).toEqual(before)
    store.dispose()
  })

  it("prepares connection commands and key exports on the selected owner", async () => {
    const mock = native()
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => command === "ssh_connection" ? (args?.download ? null : "ssh -i '/private/key' root@127.0.0.1") : mock.invoke(command, args))
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    expect(await store.applicationActions.sshConnection!("dev", false)).toContain("ssh -i")
    expect(invoke).toHaveBeenLastCalledWith("ssh_connection", { workspace: "dev", download: false })
    const hostId = "00000000-0000-4000-8000-000000000010"
    const vmId = "00000000-0000-4000-8000-000000000011"
    expect(await store.applicationActions.sshConnection!(`silo-remote:${hostId}:${vmId}`, true)).toBeNull()
    expect(invoke).toHaveBeenLastCalledWith("ssh_connection", { hostId, vmId, download: true })
    store.dispose()
  })

  it("refreshes SSH state, persists explicit exposure, and preserves rows on refresh failure", async () => {
    const mock = native()
    let failed = false
    const row = { workspace: "dev", enabled: true, port: 2222, bindAddress: "127.0.0.1", keys: [], state: "waiting", message: null, fingerprint: null, computerName: "Ada Mac", addresses: ["192.168.1.42"] }
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_ssh_access_state") { if (failed) throw new Error("private runtime details"); return { workspaces: [row] } }
      if (command === "save_ssh_access") return { workspaces: [{ ...row, ...args }] }
      return mock.invoke(command, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    await store.applicationActions.refreshSshAccess!()
    expect(store.getSnapshot().source?.sshAccess?.workspaces[0]).toEqual(row)
    const request = { workspace: "dev", enabled: true, port: 2223, bindAddress: "192.168.1.42", keys: [] }
    await store.applicationActions.saveSshAccess!(request)
    expect(invoke).toHaveBeenCalledWith("save_ssh_access", request)
    await store.refresh()
    expect(store.getSnapshot().source?.sshAccess?.workspaces[0].bindAddress).toBe("192.168.1.42")
    failed = true
    await store.applicationActions.refreshSshAccess!()
    expect(store.getSnapshot().source?.sshAccessError).toBe("Could not check SSH access.")
    expect(store.getSnapshot().source?.sshAccess?.workspaces[0].port).toBe(2223)
    store.dispose()
  })

  it("keeps personal-token connection independent from OAuth and never publishes its value", async () => {
    const mock = native()
    const base = await mock.invoke("read_application_state") as { github: Record<string, unknown> }
    const github = { ...base.github, state: "connected", personalToken: { state: "connected", saved: true, account: "token-user" } }
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => command === "save_github_personal_token" ? github : mock.invoke(command, args))
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    await store.applicationActions.saveGitHubPersonalToken!("github_pat_synthetic")
    expect(invoke).toHaveBeenCalledWith("save_github_personal_token", { token: "github_pat_synthetic" })
    expect(store.getSnapshot().source?.github.state).toBe("connected")
    expect(store.getSnapshot().source?.github.personalToken?.account).toBe("token-user")
    expect(JSON.stringify(store.getSnapshot())).not.toContain("github_pat_synthetic")
    store.dispose()
  })

  it("passes status destinations and dismisses completed push results natively", async () => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.statusActions.openSilo({ workspace: "dev", workspaceSection: "logs" })
    expect(mock.invoke).toHaveBeenCalledWith("open_main", { route: { workspace: "dev", workspaceSection: "logs" } })
    store.statusActions.dismissRepositoryPush("dev", "/workspace/repo")
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("dismiss_repository_push", { workspace: "dev", repositoryPath: "/workspace/repo" }))
    store.dispose()
  })
  it("keeps network mappings across application refresh and shares only reachable sites", async () => {
    const mock = native()
    const state = { workspaces: [{ workspace: "dev", error: null, ports: [{port:3000,hostPort:43000,scheme:"http",state:"reachable",configured:true}] }] }
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => command === "read_network_state" || command === "save_network_port" ? state : mock.invoke(command,args))
    const store = createProductionSource({...mock.bridge,invoke} as ProductionBridge)
    await store.initialize()
    await store.applicationActions.refreshNetwork?.()
    expect(store.getSnapshot().source?.workspaces[0].ports).toEqual([{port:3000,hostPort:43000,scheme:"http",configured:true,listening:true}])
    await store.refresh()
    expect(store.getSnapshot().source?.network).toEqual(state)
    await store.applicationActions.saveNetworkPort?.({workspace:"dev",port:3000,hostPort:null,scheme:"http"})
    expect(invoke).toHaveBeenCalledWith("save_network_port",{workspace:"dev",port:3000,hostPort:null,scheme:"http"})
    store.statusActions.openSite("dev",3000)
    expect(invoke).toHaveBeenCalledWith("open_network_port",{workspace:"dev",port:3000})
    store.dispose()
  })

  it("keeps cached rows after failed network checks but revokes reachable status", async () => {
    const mock = native()
    let failed = false
    const state = { workspaces: [{ workspace:"dev",error:null,ports:[{port:3000,hostPort:43000,scheme:"http",state:"reachable",configured:true}] }] }
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if(command === "read_network_state") { if(failed) throw new Error("raw runtime output"); return state }
      return mock.invoke(command,args)
    })
    const store = createProductionSource({...mock.bridge,invoke} as ProductionBridge)
    await store.initialize(); await store.applicationActions.refreshNetwork?.()
    failed = true
    await store.applicationActions.refreshNetwork?.()
    expect(store.getSnapshot().source?.network).toEqual(state)
    expect(store.getSnapshot().source?.networkError).toBe("Could not check network services.")
    expect(store.getSnapshot().source?.workspaces[0].ports[0].listening).toBe(false)
    store.dispose()
  })

  it("passes the selected folder path to the native editor action", async () => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.applicationActions.openEditor("dev", "/workspace/projects/my folder")
    expect(mock.invoke).toHaveBeenCalledWith("workspace_action", { action: "open-editor", name: "dev", path: "/workspace/projects/my folder" })
    store.dispose()
  })

  it("loads directory pages through the native bridge and validates their shape", async () => {
    const mock = native()
    const page = { snapshotId: "snapshot", entries: [{ name: "a b.txt", path: "/workspace/a b.txt", kind: "file" }], nextOffset: null }
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) =>
      command === "list_workspace_directory" ? page : mock.invoke(command, args))
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    expect(await store.applicationActions.listWorkspaceDirectory?.("dev", "/workspace", 200, "snapshot")).toEqual(page)
    expect(await store.statusActions.listWorkspaceDirectory?.("dev", "/workspace", 200, "snapshot")).toEqual(page)
    expect(invoke).toHaveBeenCalledWith("list_workspace_directory", { workspace: "dev", path: "/workspace", offset: 200, snapshotId: "snapshot" })
    page.entries[0].path = "/outside"
    await expect(store.applicationActions.listWorkspaceDirectory?.("dev", "/workspace", 0)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalledWith("workspace_action", expect.anything())
    store.dispose()
  })

  it("saves secret values only in the native request and publishes value-free metadata", async () => {
    const mock = native()
    const request = { operation: "add" as const, name: "API_TOKEN", value: "private-test-value", workspaces: ["dev"], allowedDomains: ["api.example.test"] }
    const saved = { id: "api-token", name: request.name, workspaces: request.workspaces, allowedDomains: request.allowedDomains, state: "restart-required" as const, pendingWorkspaces: ["dev"], value: request.value }
    const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "save_secret" || name === "retry_secret") return [saved]
      if (name === "remove_secret") return []
      if (name === "read_application_state") return { ...source, secrets: [saved] }
      return mock.invoke(name, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    await store.applicationActions.saveSecret(request)
    expect(invoke).toHaveBeenCalledWith("save_secret", { request })
    expect(store.getSnapshot().source?.secrets[0]).toEqual(expect.objectContaining({ pendingWorkspaces: ["dev"] }))
    expect(JSON.stringify(store.getSnapshot())).not.toContain(request.value)
    await store.applicationActions.retrySecret?.("api-token")
    expect(invoke).toHaveBeenCalledWith("retry_secret", { id: "api-token" })
    await store.applicationActions.removeSecret("api-token")
    expect(invoke).toHaveBeenCalledWith("remove_secret", { id: "api-token" })
    store.dispose()
  })

  it("propagates rejected secret saves so the editor can preserve the draft", async () => {
    const mock = native()
    const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "save_secret") throw new Error("Credential storage is locked.")
      return mock.invoke(name, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    await expect(store.applicationActions.saveSecret({ operation: "add", name: "API_TOKEN", value: "private-test-value", workspaces: ["dev"], allowedDomains: ["api.example.test"] })).rejects.toThrow("Credential storage is locked.")
    expect(store.getSnapshot().source?.secrets).toEqual(source.secrets)
    store.dispose()
  })

  it("dismisses a crash through the native owner and waits for its confirmed state", async () => {
    let finish!: (value: unknown) => void
    const command = new Promise((resolve) => { finish = resolve })
    const mock = native()
    const crashed = { ...source, workspaces: source.workspaces.map(w => ({ ...w, state: "failed", canDismissError: true })) }
    const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => name === "workspace_action" ? command : name === "read_application_state" ? crashed : mock.invoke(name, args))
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    store.applicationActions.dismissWorkspaceError("dev")
    expect(invoke).toHaveBeenCalledWith("workspace_action", { action: "dismiss-error", name: "dev" })
    expect(store.getSnapshot().source?.workspaces[0].state).toBe("failed")
    expect(store.getSnapshot().source?.workspaces[0].lifecycleAction).toBe("dismiss-error")
    store.applicationActions.startWorkspace("dev")
    expect(invoke.mock.calls.filter(([name]) => name === "workspace_action")).toHaveLength(1)
    finish(crashed)
    await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces[0].lifecycleAction).toBeUndefined())
    store.dispose()
  })

  it("shows restart immediately, keeps it through refresh, and blocks conflicting actions", async () => {
    let finish!: (value: unknown) => void
    const command = new Promise((resolve) => { finish = resolve })
    const mock = native()
    const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => name === "workspace_action" ? command : mock.invoke(name, args))
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    store.applicationActions.restartWorkspace("dev")
    expect(store.getSnapshot().source?.workspaces[0].lifecycleAction).toBe("restart")
    await store.refresh()
    expect(store.getSnapshot().source?.workspaces[0].lifecycleAction).toBe("restart")
    store.applicationActions.restartWorkspace("dev")
    store.applicationActions.stopWorkspace("dev")
    expect(invoke.mock.calls.filter(([name]) => name === "workspace_action")).toHaveLength(1)
    finish(source)
    await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces[0].lifecycleAction).toBeUndefined())
    store.dispose()
  })

  it("does not clear restart feedback when an earlier terminal action finishes", async () => {
    let finishTerminal!: (value: unknown) => void
    let finishRestart!: (value: unknown) => void
    const terminal = new Promise((resolve) => { finishTerminal = resolve })
    const restart = new Promise((resolve) => { finishRestart = resolve })
    const mock = native()
    const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => name === "workspace_action" ? args?.action === "restart" ? restart : terminal : mock.invoke(name, args))
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    store.applicationActions.openTerminal("dev")
    store.applicationActions.restartWorkspace("dev")
    finishTerminal(source)
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([name]) => name === "read_application_state").length).toBeGreaterThan(1))
    expect(store.getSnapshot().source?.workspaces[0].lifecycleAction).toBe("restart")
    finishRestart(source)
    await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces[0].lifecycleAction).toBeUndefined())
    store.dispose()
  })

  it("publishes saved sandbox configuration before requesting live state", async () => {
    const machines = source.workspaces.map(({ machine }) => structuredClone(machine))
    const invoke = vi.fn().mockResolvedValue({ schemaVersion: 1, machines })
    const mock = native({ invoke })
    const store = createProductionSource(mock.bridge)
    const changed = vi.fn()
    store.subscribe(changed)

    await store.loadConfiguration()

    expect(invoke).toHaveBeenCalledExactlyOnceWith("read_machine_configuration")
    expect(store.getSnapshot()).toMatchObject({ savedMachines: machines, source: null, loading: true, error: null })
    expect(changed).toHaveBeenCalledOnce()
    store.dispose()
  })

  it("accepts an empty saved configuration for a fresh install", async () => {
    const mock = native({ invoke: vi.fn().mockResolvedValue({ schemaVersion: 1, machines: [] }) })
    const store = createProductionSource(mock.bridge)

    await store.loadConfiguration()

    expect(store.getSnapshot().savedMachines).toEqual([])
    expect(store.getSnapshot().source).toBeNull()
    store.dispose()
  })

  it.each([
    { schemaVersion: 2, machines: [] },
    { schemaVersion: 1, machines: [{ name: "invalid" }] },
    { schemaVersion: 1, machines: "unreadable" },
    null,
  ])("rejects malformed saved configuration without publishing sandbox rows: %j", async (configuration) => {
    const mock = native({ invoke: vi.fn().mockResolvedValue(configuration) })
    const store = createProductionSource(mock.bridge)

    await expect(store.loadConfiguration()).rejects.toThrow()

    expect(store.getSnapshot().savedMachines).toBeUndefined()
    expect(store.getSnapshot().source).toBeNull()
    store.dispose()
  })

  it("shows an authoritative host push failure without success", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    let failed = false
    const failure = { workspace: "dev", repositoryPath: "/workspace/repo", status: "failed" as const, commitCount: 0, message: "Repository authorization was removed" }
    mock.invoke.mockImplementation((command, args) => {
      if (command === "start_repository_push") { failed = true; return Promise.resolve(failure) }
      if (command === "read_application_state" && failed) return Promise.resolve({ ...structuredClone(source), repositoryPushOperations: [failure] })
      return original(command, args)
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.pushRepository("dev", "/workspace/repo")
    await vi.waitFor(() => expect(store.getSnapshot().source?.repositoryPushOperations).toContainEqual({ workspace: "dev", repositoryPath: "/workspace/repo", commitCount: 0, status: "failed", message: "Repository authorization was removed" }))
    expect(mock.invoke).toHaveBeenCalledWith("start_repository_push", { workspace: "dev", repositoryPath: "/workspace/repo", operationId: expect.any(String) })
    store.dispose()
  })

  it("blocks an unknown push until the user acknowledges checking GitHub", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    const unknown = { workspace: "dev", repositoryPath: "/workspace/repo", status: "unknown" as const, commitCount: 0, message: "Check this branch on GitHub before retrying." }
    let acknowledged = false
    mock.invoke.mockImplementation((command, args) => {
      if (command === "read_application_state") return Promise.resolve({ ...structuredClone(source), repositoryPushOperations: acknowledged ? [] : [unknown] })
      if (command === "dismiss_repository_push") { acknowledged = true; return Promise.resolve() }
      if (command === "start_repository_push") return Promise.resolve({ status: "failed", commitCount: 0, message: "Test completed" })
      return original(command, args)
    })
    const store = createProductionSource(mock.bridge)
    try {
      await store.initialize()
      store.applicationActions.pushRepository("dev", "/workspace/repo")
      expect(mock.invoke.mock.calls.some(([command]) => command === "start_repository_push")).toBe(false)
      store.applicationActions.dismissRepositoryPush!("dev", "/workspace/repo")
      await vi.waitFor(() => expect(store.getSnapshot().source?.repositoryPushOperations).toEqual([]))
      expect(mock.invoke.mock.calls.some(([command]) => command === "start_repository_push")).toBe(false)
      store.applicationActions.pushRepository("dev", "/workspace/repo")
      await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("start_repository_push", { workspace: "dev", repositoryPath: "/workspace/repo", operationId: expect.any(String) }))
    } finally { store.dispose() }
  })

  it("reports a failed account connection once without inventing sandbox failures", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation((command, args) => command === "connect_github" ? Promise.reject(new Error("GitHub is not configured in this build")) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const before = store.getSnapshot().source!.github
    store.applicationActions.connectGitHub!()
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.repositoryCatalogStatus).toEqual({ status: "unavailable", message: "GitHub operation failed: GitHub is not configured in this build", canRetry: false }))
    expect(store.getSnapshot().source?.github.workspaceOperations).toEqual(before.workspaceOperations)
    expect(store.getSnapshot().source?.github.account).toEqual(before.account)
    store.dispose()
  })

  it("shows native OAuth progress while browser login is pending, then connected state", async () => {
    const events = new Map<string, () => void>()
    let liveState = { ...source, github: { ...source.github, state: "disconnected" as const, account: undefined } } as typeof source
    let finishLogin!: (value: unknown) => void
    const invoke = vi.fn(async (command: string) => {
      if (command === "read_application_state") return structuredClone(liveState)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "connect_github") return new Promise((resolve) => { finishLogin = resolve })
      return []
    })
    const store = createProductionSource({ invoke, listen: async (event, handler) => { events.set(event, handler); return () => events.delete(event) } } as ProductionBridge)
    await store.initialize()
    store.applicationActions.connectGitHub!()
    liveState = { ...liveState, github: { ...liveState.github, state: "connecting" } }
    events.get("silo://application-state-changed")!()
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.state).toBe("connecting"))
    finishLogin({ ...liveState.github, state: "connected", account: "test-account" })
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.state).toBe("connected"))
    expect(store.getSnapshot().source?.github.account).toBe("test-account")
    store.dispose()
  })

  it.each(["resolve", "reject"])("cancels authorization without a failure or stale %s changing account state", async (completion) => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    let finishLogin!: (value: unknown) => void
    let failLogin!: (cause: Error) => void
    const disconnected = { ...source.github, state: "disconnected", account: null }
    mock.invoke.mockImplementation((command, args) => {
      if (command === "connect_github") return new Promise((resolve, reject) => { finishLogin = resolve; failLogin = reject })
      if (command === "cancel_github_connection") return Promise.resolve(disconnected)
      return original(command, args)
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.connectGitHub!()
    store.applicationActions.cancelGitHubConnection!()
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.state).toBe("disconnected"))
    if (completion === "resolve") finishLogin({ ...source.github, state: "connected", account: "late-account" })
    else failLogin(new Error("GitHub authorization was cancelled"))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().source?.github.state).toBe("disconnected")
    expect(store.getSnapshot().source?.github.account).toBeUndefined()
    expect(store.getSnapshot().error).toBeNull()
    expect((store.getSnapshot().setupActivity ?? []).some(event => event.message.includes("did not complete") || event.message === "GitHub account connected.")).toBe(false)
    store.dispose()
  })

  it("loads newly authorized repositories once when returning from GitHub", async () => {
    const mock = native()
    const updatedGitHub = { ...source.github, state: "connected", repositoryCatalog: ["acme/new-repository"] }
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "refresh_github_repositories") return updatedGitHub
      return mock.invoke(command, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    await store.initialize()
    try {
      window.dispatchEvent(new Event("focus"))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(invoke.mock.calls.filter(([command]) => command === "refresh_github_repositories")).toHaveLength(0)
      store.applicationActions.manageGitHubRepositories!()
      expect(invoke).toHaveBeenCalledWith("manage_github_repositories")
      window.dispatchEvent(new Event("focus"))
      await vi.waitFor(() => expect(store.getSnapshot().source?.github.repositoryCatalog).toEqual(["acme/new-repository"]))
      window.dispatchEvent(new Event("focus"))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(invoke.mock.calls.filter(([command]) => command === "refresh_github_repositories")).toHaveLength(1)
    } finally { store.dispose() }
  })

  it("reopens the browser without replacing an active connection attempt", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    let finishLogin!: (value: unknown) => void
    mock.invoke.mockImplementation((command, args) => {
      if (command === "connect_github") return new Promise(resolve => { finishLogin = resolve })
      if (command === "reopen_github_authorization") return Promise.resolve(null)
      return original(command, args)
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.connectGitHub!()
    store.applicationActions.reopenGitHubAuthorization!()
    expect(mock.invoke).toHaveBeenCalledWith("reopen_github_authorization")
    finishLogin({ ...source.github, state: "connected", account: "test-account" })
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.account).toBe("test-account"))
    expect(store.getSnapshot().error).toBeNull()
    store.dispose()
  })

  it("restores native disconnected state after cancelled browser login", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation((command, args) => {
      if (command === "read_application_state") return Promise.resolve({ ...source, github: { ...source.github, state: "connecting" } })
      if (command === "connect_github") return Promise.reject(new Error("GitHub authorization was cancelled"))
      if (command === "read_github_state") return Promise.resolve({ ...source.github, state: "disconnected", account: null })
      return original(command, args)
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.connectGitHub!()
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.state).toBe("disconnected"))
    expect(store.getSnapshot().source?.github.account).toBeUndefined()
    expect(store.getSnapshot().source?.github.repositoryCatalogStatus).toMatchObject({ status: "unavailable", canRetry: false })
    store.dispose()
  })

  it("returns native save failures without making the available repository catalog unavailable", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation((command, args) => command === "save_github_configuration" ? Promise.reject(new Error("Invalid Git identity settings.")) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const catalog = store.getSnapshot().source?.github.repositoryCatalogStatus
    await expect(store.applicationActions.saveGitHubConfiguration!({ accessEnabled: true, hostIdentity: null, workspaces: [] })).rejects.toThrow("Invalid Git identity settings.")
    expect(store.getSnapshot().source?.github.repositoryCatalogStatus).toEqual(catalog)
    expect(store.getSnapshot().error).toContain("Invalid Git identity settings.")
    store.dispose()
  })

  it("ignores an older settings response after a newer save completes", async () => {
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    const pending: Array<(value: unknown) => void> = []
    mock.invoke.mockImplementation((command, args) => command === "save_github_configuration" ? new Promise((resolve) => { pending.push(resolve) }) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const configuration = { accessEnabled: true, hostIdentity: null, workspaces: [] }
    store.applicationActions.saveGitHubConfiguration!(configuration)
    store.applicationActions.saveGitHubConfiguration!({ ...configuration, accessEnabled: false })
    pending[1]({ ...source.github, policyRevision: 2, accessEnabled: false })
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.policyRevision).toBe(2))
    pending[0]({ ...source.github, policyRevision: 1, accessEnabled: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getSnapshot().source?.github.accessEnabled).toBe(false)
    expect(store.getSnapshot().source?.github.policyRevision).toBe(2)
    store.dispose()
  })

  it("keeps all-repository intent and waits for native acknowledgment before showing changed access", async () => {
    let resolveMutation!: (value: unknown) => void
    const request = { accessEnabled: false, hostIdentity: null, workspaces: [{ workspace: "dev", repositoryMode: "all" as const, allRepositoriesAllowChanges: false, repositories: [], identity: { name: "", email: "", apply: false } }] }
    const mock = native()
    const original = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation((command, args) => command === "save_github_configuration" ? new Promise((resolve) => { resolveMutation = resolve }) : original(command, args))
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const before = store.getSnapshot().source?.github
    store.applicationActions.saveGitHubConfiguration!(request)
    expect(mock.invoke).toHaveBeenCalledWith("save_github_configuration", { configuration: request })
    expect(store.getSnapshot().source?.github).toBe(before)
    resolveMutation({ ...before, ...request, workspaceOperations: [{ workspace: "dev", status: "failed", message: "Runtime did not acknowledge access", canRetry: true }] })
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.workspaceOperations?.[0].status).toBe("failed"))
    expect(store.getSnapshot().source?.github.workspaces?.[0].repositoryMode).toBe("all")
    store.dispose()
  })

  it("updates asynchronous workspace acknowledgment from a native state event", async () => {
    const events = new Map<string, () => void>()
    let github = { ...source.github, policyRevision: 11, workspaceOperations: [{ workspace: "dev", status: "applying" as const, message: "Applying access" }] } as typeof source.github
    const store = createProductionSource({
      invoke: async (command: string) => {
        if (command === "read_application_state") return { ...source, github }
        if (command === "read_backup_state") return backup
        if (command === "save_github_configuration") return github
        return []
      },
      listen: async (event, handler) => { events.set(event, handler); return () => events.delete(event) },
    } as ProductionBridge)
    await store.initialize()
    store.applicationActions.saveGitHubConfiguration!({ accessEnabled: true, hostIdentity: null, workspaces: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getSnapshot().source?.github.workspaceOperations?.[0].status).toBe("applying")
    github = { ...github, workspaceOperations: [{ workspace: "dev", status: "succeeded", message: "Verified access" }] }
    events.get("silo://application-state-changed")!()
    await vi.waitFor(() => expect(store.getSnapshot().source?.github.workspaceOperations?.[0].status).toBe("succeeded"))
    store.dispose()
  })

  it("accepts the exact native GitHub states without granting implicit all-repository writes", () => {
    const states = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../test/contracts/github-state.json"), "utf8")) as Array<typeof source.github>
    for (const github of states) {
      const parsed = parseApplicationSource({ ...source, github }).github
      expect(parsed).toEqual(github)
      expect(parsed.workspaces?.[0]).toMatchObject({ repositoryMode: "all", allRepositoriesAllowChanges: false, repositories: [] })
      expect(parsed.policyRevision).toBe(7)
    }
  })

  it("accepts activity serialized by the native journal", () => {
    const events = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../test/contracts/setup-activity.json"), "utf8")) as unknown[]
    expect(events.map((event) => siloProgressEventSchema.parse(event))).toEqual(events)
  })
  it("accepts the exact backup state serialized by the Rust bridge", () => {
    const state = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../test/contracts/backup-state.json"), "utf8"))
    expect(parseBackupState(state)).toEqual(state)
  })

  it("accepts running and failed-result variants serialized by Rust", () => {
    const operations = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../test/contracts/backup-operations.json"), "utf8")) as unknown[]
    for (const operation of operations) expect(parseBackupState({ ...backup, operation }).operation).toEqual(operation)
  })

  it("rejects malformed authoritative state instead of substituting preview data", () => {
    expect(() => parseApplicationSource({ workspaces: [] })).toThrow()
    expect(() => parseBackupState({ availability: "available", archives: [] })).toThrow()
  })

  it("does not hide a failed live-update subscription behind an initial snapshot", async () => {
    const unsubscribe = vi.fn()
    const listen = vi.fn().mockResolvedValueOnce(unsubscribe).mockRejectedValueOnce(new Error("event channel closed"))
    const mock = native({ listen })
    const store = createProductionSource(mock.bridge)
    await expect(store.initialize()).rejects.toThrow("Silo could not subscribe to application updates: event channel closed")
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(store.getSnapshot().source).toBeNull()
    store.dispose()
  })

  it("loads both native snapshots and refreshes after a workspace action", async () => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(store.getSnapshot().source?.workspaces[0].machine.name).toBe("dev")
    expect(store.getSnapshot().backup.archives[0].archivePath).toBe("/tmp/dev.silo-backup")
    store.applicationActions.stopWorkspace("dev")
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("workspace_action", { action: "stop", name: "dev" }))
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([command]) => command === "read_application_state")).toHaveLength(2))
    store.dispose()
  })

  it("keeps detected identity across VM results that omit it, then accepts a fresh missing identity", async () => {
    const hostIdentity = { name: "Host Author", email: "host@example.test" }
    let currentIdentity: typeof hostIdentity | undefined = hostIdentity
    const machineResult = structuredClone(source)
    delete machineResult.github.hostIdentity
    const mock = native({ invoke: vi.fn(async (command) => {
      if (command === "read_application_state") return { ...structuredClone(source), github: { ...source.github, hostIdentity: currentIdentity } }
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "read_setup_activity") return []
      if (command === "save_machine_configuration") return machineResult
    }) as ProductionBridge["invoke"] })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    await store.configureMachines({ schemaVersion: 1, machines: source.workspaces.map(({ machine }) => machine) })
    expect(store.getSnapshot().source?.github.hostIdentity).toEqual(hostIdentity)
    currentIdentity = undefined
    await store.refresh()
    expect(store.getSnapshot().source?.github.hostIdentity).toBeUndefined()
    store.dispose()
  })

  it("keeps captured logs during configuration and reloads them after it finishes", async () => {
    const initial = structuredClone(source)
    const oldLog = { line: "VM booted", occurredAt: "2026-09-10T09:00:00Z" }
    const newLog = { line: "VM stopped", occurredAt: "2026-09-10T09:01:00Z" }
    initial.workspaces[0].logs = [oldLog]
    const mutation = structuredClone(initial)
    mutation.workspaces[0].logs = []
    let reads = 0
    const invoke = vi.fn(async (command: string) => {
      if (command === "read_application_state") {
        const result = structuredClone(initial)
        if (++reads > 1) result.workspaces[0].logs = [oldLog, newLog]
        return result
      }
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "read_setup_activity") return []
      if (command === "save_machine_configuration") return mutation
    })
    const store = createProductionSource(native({ invoke: invoke as ProductionBridge["invoke"] }).bridge)
    await store.initialize()
    const observed: number[] = []
    const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot().source?.workspaces[0].logs.length ?? -1))
    await store.configureMachines({ schemaVersion: 1, machines: initial.workspaces.map(({ machine }) => machine) })
    expect(observed).not.toContain(0)
    expect(store.getSnapshot().source?.workspaces[0].logs).toEqual([oldLog, newLog])
    unsubscribe()
    store.dispose()
  })

  it("retains an unscoped preflight error and lets dismissal unlock the committed configuration", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "read_setup_activity") return []
      if (command === "save_machine_configuration") throw new Error("Stop sandbox 'dev' before removing it.")
    })
    const store = createProductionSource(native({ invoke: invoke as ProductionBridge["invoke"] }).bridge)
    await store.initialize()
    const committedWorkspaces = store.getSnapshot().source?.workspaces.map(({ machine }) => machine)
    await expect(store.configureMachines({ schemaVersion: 1, machines: [] })).rejects.toThrow("Stop sandbox")
    expect(store.getSnapshot().source?.sandboxConfigurationOperation).toMatchObject({ status: "failed", error: { workspace: null, message: "Stop sandbox 'dev' before removing it." } })
    store.applicationActions.dismissMachineConfigurationError()
    await store.refresh()
    expect(store.getSnapshot().source?.sandboxConfigurationOperation).toBeNull()
    expect(store.getSnapshot().source?.workspaces.map(({ machine }) => machine)).toEqual(committedWorkspaces)
    store.dispose()
  })

  it("retries verification only for the requested sandbox", async () => {
    let attempts = 0
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "read_setup_activity") return []
      if (command === "save_machine_configuration") {
        if (++attempts === 1) throw new Error("Verification failed")
        return structuredClone(source)
      }
    })
    const store = createProductionSource(native({ invoke: invoke as ProductionBridge["invoke"] }).bridge)
    await store.initialize()
    const request = { schemaVersion: 1 as const, machines: source.workspaces.map(({ machine }) => machine) }
    await expect(store.configureMachines(request)).rejects.toThrow("Verification failed")
    store.applicationActions.retryMachineConfiguration("dev")
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("save_machine_configuration", {
      request, requestId: expect.any(String), retryWorkspace: "dev",
    }))
    await vi.waitFor(() => expect(store.getSnapshot().source?.sandboxConfigurationOperation).toBeNull())
    store.dispose()
  })

  it("reports unreadable activity without replacing it with success or raw diagnostics", async () => {
    const mock = native({ invoke: vi.fn(async (command) => {
      if (command === "read_setup_activity") throw new Error("private path and token")
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
    }) as ProductionBridge["invoke"] })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(store.getSnapshot().setupActivityError).toBe("Saved setup activity could not be loaded. Retry by reopening Silo.")
    expect(store.getSnapshot().setupEvents).toEqual([])
    expect(store.getSnapshot().source).not.toBeNull()
    store.dispose()
  })

  it("coalesces duplicate in-flight workspace actions", async () => {
    let finish: (() => void) | undefined
    const mock = native()
    mock.invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "workspace_action") {
        await new Promise<void>((resolve) => { finish = resolve })
        return structuredClone(source)
      }
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.stopWorkspace("dev")
    store.applicationActions.stopWorkspace("dev")
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([command]) => command === "workspace_action")).toHaveLength(1))
    finish?.()
    store.dispose()
  })

  it("keeps a sandbox action failure through refresh and clears it after a successful retry", async () => {
    const mock = native()
    let refuse = true
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "workspace_action") {
        if (refuse) throw new Error("runtime refused stop")
        return structuredClone(source)
      }
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.applicationActions.stopWorkspace("dev")
    await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.lifecycleFailure).toBe("Stop failed: runtime refused stop"))
    expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.state).toBe("running")
    expect(store.getSnapshot().source?.vmOperationsUnavailable).toBeUndefined()
    expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.freshness).toBe("stale")
    expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.lifecycleAction).toBeUndefined()
    await store.refresh()
    expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.lifecycleFailure).toContain("runtime refused stop")
    expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.freshness).toBe("fresh")
    expect(store.getSnapshot().source?.workspaces.filter(({ machine }) => machine.name !== "dev").every(workspace => !workspace.lifecycleFailure && workspace.freshness === "fresh")).toBe(true)
    refuse = false
    store.applicationActions.stopWorkspace("dev")
    await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces.find(({ machine }) => machine.name === "dev")?.lifecycleFailure).toBeUndefined())
    store.dispose()
  })

  it("clears stale application state when an authoritative refresh fails", async () => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(store.getSnapshot().source?.workspaces[0].machine.name).toBe("dev")
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "read_application_state") throw new Error("runtime state unavailable")
      if (command === "read_backup_state") return structuredClone(backup)
      return undefined
    })
    await store.refresh()
    expect(store.getSnapshot().source).toBeNull()
    expect(store.getSnapshot().error).toBe("Silo could not read application state: runtime state unavailable")
    store.dispose()
  })

  it("keeps the mounted application and restore progress while configuration is updating", async () => {
    const mock = native()
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const updating = { ...backup, operation: { kind: "running", operation: "restore", archive: backup.archives[0], runningNames: [], targetName: "copy", progress: 0, indeterminate: true, phases: [{ title: "Creating restored sandbox", detail: "", tone: "running" }] } }
    mock.invoke.mockImplementation(async (command) => {
      if (command === "read_application_state") throw new Error("SILO_SANDBOX_UPDATE_IN_PROGRESS")
      if (command === "read_backup_state") return updating
    })
    await store.refresh()
    expect(store.getSnapshot().source?.workspaces[0].machine.name).toBe("dev")
    expect(store.getSnapshot().error).toBeNull()
    expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "running", phases: [{ title: "Creating restored sandbox" }] })
    // A later authoritative snapshot remains responsible for reporting success.
    mock.invoke.mockImplementation(async (command) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return { ...backup, operation: { kind: "result", operation: "restore", archive: backup.archives[0], runningNames: [], outcome: "success", title: "Restored", message: "Sandbox restored successfully." } }
    })
    await store.refresh()
    expect(store.getSnapshot().source).not.toBeNull()
    expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "result", outcome: "success" })
    store.dispose()
  })

  it("keeps a visible failed restore result when native operation state is malformed", async () => {
    let broken = false
    const mock = native()
    mock.invoke.mockImplementation(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "start_restore") { broken = true; return undefined }
      if (command === "read_backup_state") return broken ? { ...backup, operation: { kind: "running", running_names: [] } } : structuredClone(backup)
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.backupActions.startRestore(backup.archives[0], "restored", "dev")
    await vi.waitFor(() => expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "result", operation: "restore", outcome: "failed", targetName: "restored" }))
    expect(store.getSnapshot().backup.operation).toMatchObject({ message: expect.stringContaining("invalid backup state") })
    store.dispose()
  })

  it("shows restore immediately, ignores stale results and dismisses results locally", async () => {
    const completed = { operation: "backup" as const, archive: backup.archives[0], runningNames: [], kind: "result" as const, outcome: "success" as const, title: "Backup complete", message: "Backup completed successfully." }
    let release: (() => void) | undefined
    let current = { ...structuredClone(backup), operation: completed, operationId: "first-operation" } as BackupState
    const mock = native({ invoke: vi.fn(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(current)
      if (command === "start_restore") await new Promise<void>(resolve => { release = resolve })
    }) as ProductionBridge["invoke"] })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.backupActions.dismissOperation()
    expect(store.getSnapshot().backup.operation).toBeNull()
    await store.refresh()
    expect(store.getSnapshot().backup.operation).toBeNull()
    store.backupActions.startRestore(backup.archives[0], "restored", "dev")
    expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "running", operation: "restore", indeterminate: true })
    await store.refresh()
    expect(store.getSnapshot().backup.operation?.kind).toBe("running")
    store.backupActions.dismissOperation()
    expect(store.getSnapshot().backup.operation?.kind).toBe("running")
    expect(mock.bridge.invoke).toHaveBeenCalledWith("dismiss_backup_operation", { expectedOperation: completed, expectedOperationId: "first-operation" })
    expect(vi.mocked(mock.bridge.invoke).mock.calls.filter(([command]) => command === "dismiss_backup_operation")).toHaveLength(1)
    current = { ...current, operationId: "second-operation", operation: { ...completed, operation: "restore", targetName: "restored", title: "Restore complete" } }
    await store.refresh()
    expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "result", operation: "restore" })
    store.backupActions.dismissOperation()
    release?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    await store.refresh()
    expect(store.getSnapshot().backup.operation).toBeNull()
    store.dispose()
  })

  it("keeps a submission failure visible across refreshes until dismissed", async () => {
    const completed = { operation: "backup" as const, archive: backup.archives[0], runningNames: [], kind: "result" as const, outcome: "success" as const, title: "Backup complete", message: "Backup completed successfully." }
    const mock = native({ invoke: vi.fn(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return { ...backup, operation: completed }
      if (command === "start_restore") throw new Error("Sandbox name already exists")
    }) as ProductionBridge["invoke"] })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.backupActions.startRestore(backup.archives[0], "dev", "dev")
    await vi.waitFor(() => expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "result", outcome: "failed" }))
    await store.refresh()
    expect(store.getSnapshot().backup.operation).toMatchObject({ kind: "result", outcome: "failed", message: "Sandbox name already exists" })
    store.backupActions.dismissOperation()
    await store.refresh()
    expect(store.getSnapshot().backup.operation).toBeNull()
    store.dispose()
  })

  it("announces archive selection before waiting for validation", async () => {
    let release: (() => void) | undefined
    const mock = native({ invoke: vi.fn(async (command: string) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "choose_backup_archive") return "/tmp/dev.silo-backup"
      if (command === "inspect_backup_archive") {
        await new Promise<void>(resolve => { release = resolve })
        return { archive: backup.archives[0], valid: true }
      }
    }) as ProductionBridge["invoke"] })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    const selected = vi.fn()
    const inspection = store.backupActions.chooseArchive(selected)
    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith("/tmp/dev.silo-backup"))
    release?.()
    await inspection
    store.dispose()
  })

  it("coalesces duplicate in-flight backup starts", async () => {
    let finish: (() => void) | undefined
    const mock = native()
    mock.invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "start_backup") await new Promise<void>((resolve) => { finish = resolve })
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    store.backupActions.startBackup("/Volumes/Backups", ["dev"])
    store.backupActions.startBackup("/Volumes/Backups", ["dev"])
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([command]) => command === "start_backup")).toHaveLength(1))
    finish?.()
    store.dispose()
  })

  it("uses native archive paths and destination pickers", async () => {
    const mock = native()
    mock.invoke.mockImplementation(async (command: string, _arguments_?: Record<string, unknown>) => {
      if (command === "read_application_state") return structuredClone(source)
      if (command === "read_backup_state") return structuredClone(backup)
      if (command === "choose_backup_destination") return "/Volumes/Backups"
      if (command === "choose_backup_archive") return "/Volumes/Backups/dev.silo-backup"
      if (command === "inspect_backup_archive") return { archive: backup.archives[0], valid: true }
      return undefined
    })
    const store = createProductionSource(mock.bridge)
    await store.initialize()
    expect(await store.backupActions.chooseDestination()).toBe("/Volumes/Backups")
    await store.backupActions.chooseArchive()
    expect(mock.invoke).toHaveBeenCalledWith("inspect_backup_archive", { archivePath: "/Volumes/Backups/dev.silo-backup" })
    store.backupActions.startRestore(backup.archives[0], "dev-restored")
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("start_restore", { archivePath: "/tmp/dev.silo-backup", newName: "dev-restored" }))
    store.dispose()
  })
})

describe("remote SSH access", () => {
  const vmId = source.workspaces[0].machine.id
  const target = `silo-remote:office:${encodeURIComponent(vmId)}`
  const request = { workspace: target, enabled: true, port: 2222, bindAddress: "127.0.0.1", keys: [] }
  const row = { ...request, state: "listening", message: null, fingerprint: "SHA256:fixture", computerName: "Office Mac", addresses: ["192.168.1.42"] }
  function fixture() {
    const mock = native()
    let failOffice: string | undefined
    let failLocal = false
    let officeRead: Promise<unknown> | undefined
    let officeSave: Promise<unknown> | undefined
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command === "remote_host_list") return [{ id: "office", name: "Office Mac", address: "user@office" }, { id: "lab", name: "Lab Mac", address: "user@lab" }]
      if (command === "remote_host_snapshot") return { ...source, workspaces: [source.workspaces[0]] }
      if (command === "read_ssh_access_state") { if (failLocal) throw new Error("Local failed"); return { workspaces: [{ ...row, workspace: "dev", computerName: "Laptop" }] } }
      if (command === "remote_ssh_access_state") {
        if (args?.hostId === "office") { if (failOffice) throw new Error(failOffice); if (officeRead) return officeRead }
        return { workspaces: [{ ...row, workspace: `silo-remote:${args?.hostId}:${encodeURIComponent(vmId)}`, computerName: args?.hostId === "office" ? "Office Mac" : "Lab Mac" }] }
      }
      if (command === "remote_save_ssh_access") { if (officeSave) return officeSave; const { hostId, vmId: id, ...settings } = args!; return { workspaces: [{ ...row, ...settings, workspace: `silo-remote:${hostId}:${encodeURIComponent(String(id))}` }] } }
      if (command === "save_ssh_access") return { workspaces: [{ ...row, ...args, computerName: "Laptop" }] }
      return mock.invoke(command, args)
    })
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    return { store, invoke, failOffice: (message = "private remote details") => { failOffice = message }, failLocal: () => { failLocal = true }, delayOffice: (promise: Promise<unknown>) => { officeRead = promise }, delaySave: (promise: Promise<unknown>) => { officeSave = promise } }
  }
  it("routes same-name remote sandboxes by immutable owner and VM IDs and retains other owners", async () => {
    const { store, invoke } = fixture()
    try {
      await store.initialize(); await store.applicationActions.refreshSshAccess!()
      expect(store.getSnapshot().source?.sshAccess?.workspaces.map(item => item.workspace)).toEqual(["dev", target, `silo-remote:lab:${encodeURIComponent(vmId)}`])
      await store.applicationActions.saveSshAccess!({ ...request, keys: ["ssh-ed25519 synthetic-public-key"] })
      expect(invoke).toHaveBeenCalledWith("remote_save_ssh_access", { hostId: "office", vmId, enabled: true, port: 2222, bindAddress: "127.0.0.1", keys: ["ssh-ed25519 synthetic-public-key"] })
      expect(invoke).not.toHaveBeenCalledWith("save_ssh_access", expect.anything())
      expect(store.getSnapshot().source?.sshAccess?.workspaces).toHaveLength(3)
      await store.applicationActions.saveSshAccess!({ ...request, workspace: "dev", enabled: false })
      expect(store.getSnapshot().source?.sshAccess?.workspaces).toHaveLength(3)
      expect(store.getSnapshot().source?.sshAccess?.workspaces.find(item => item.workspace === target)?.keys).toEqual(["ssh-ed25519 synthetic-public-key"])
    } finally { store.dispose() }
  })
  it("retains cached keys while a failed owner becomes unavailable and healthy owners remain writable", async () => {
    const { store, failOffice, failLocal } = fixture()
    try {
      await store.initialize(); await store.applicationActions.refreshSshAccess!()
      await store.applicationActions.saveSshAccess!({ ...request, keys: ["ssh-ed25519 retained-key"] })
      failOffice(); await store.applicationActions.refreshSshAccess!()
      const rows = store.getSnapshot().source?.sshAccess?.workspaces
      expect(rows?.find(item => item.workspace === target)).toMatchObject({ enabled: true, keys: ["ssh-ed25519 retained-key"], unavailable: expect.stringContaining("Office Mac") })
      expect(rows?.find(item => item.workspace === "dev")?.unavailable).toBeUndefined()
      expect(rows?.find(item => item.workspace.startsWith("silo-remote:lab:"))?.unavailable).toBeUndefined()
      await expect(store.applicationActions.saveSshAccess!({ ...request, keys: [] })).rejects.toThrow("Refresh SSH status")
      await store.applicationActions.saveSshAccess!({ ...request, workspace: "dev", enabled: false })
      failLocal(); await store.applicationActions.refreshSshAccess!()
      expect(store.getSnapshot().source?.sshAccess?.workspaces.find(item => item.workspace === "dev")?.unavailable).toBeDefined()
      expect(store.getSnapshot().source?.sshAccess?.workspaces.find(item => item.workspace.startsWith("silo-remote:lab:"))?.unavailable).toBeUndefined()
    } finally { store.dispose() }
  })
  it("explains that an older owner must update Silo instead of reconnecting", async () => {
    const { store, failOffice } = fixture()
    try {
      await store.initialize(); await store.applicationActions.refreshSshAccess!()
      failOffice("This Silo version does not support that remote operation.")
      await store.applicationActions.refreshSshAccess!()
      const row = store.getSnapshot().source?.sshAccess?.workspaces.find(item => item.workspace === target)
      expect(row?.unavailable).toBe("Update Silo on Office Mac to manage SSH access. That version does not support remote SSH management.")
      expect(row?.unavailable).not.toContain("Reconnect")
      await expect(store.applicationActions.saveSshAccess!(request)).rejects.toThrow("Refresh SSH status")
      expect(store.getSnapshot().source?.sshAccess?.workspaces.find(item => item.workspace === "dev")?.unavailable).toBeUndefined()
    } finally { store.dispose() }
  })
  it("rejects old read results even when polling starts during a pending revocation", async () => {
    const { store, delayOffice, delaySave } = fixture()
    let resolveRead!: (value: unknown) => void
    let resolveSave!: (value: unknown) => void
    try {
      await store.initialize(); await store.applicationActions.refreshSshAccess!()
      delaySave(new Promise(resolve => { resolveSave = resolve }))
      const saving = store.applicationActions.saveSshAccess!({ ...request, keys: [] })
      delayOffice(new Promise(resolve => { resolveRead = resolve }))
      const refreshing = store.applicationActions.refreshSshAccess!()
      resolveSave({ workspaces: [{ ...row, keys: [] }] })
      await saving
      resolveRead({ workspaces: [{ ...row, keys: ["ssh-ed25519 revoked-key"] }] })
      await refreshing
      expect(store.getSnapshot().source?.sshAccess?.workspaces.find(item => item.workspace === target)?.keys).toEqual([])
    } finally { store.dispose() }
  })
  it("does not let a delayed remote refresh restore a revoked key", async () => {
    const { store, delayOffice, invoke } = fixture()
    let resolveRead!: (value: unknown) => void
    try {
      await store.initialize(); await store.applicationActions.refreshSshAccess!()
      delayOffice(new Promise(resolve => { resolveRead = resolve }))
      const refresh = store.applicationActions.refreshSshAccess!()
      await vi.waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === "remote_ssh_access_state" && call[1]?.hostId === "office")).toHaveLength(2))
      await store.applicationActions.saveSshAccess!({ ...request, keys: [] })
      resolveRead({ workspaces: [{ ...row, keys: ["ssh-ed25519 revoked-key"] }] })
      await refresh
      expect(store.getSnapshot().source?.sshAccess?.workspaces.find(item => item.workspace === target)?.keys).toEqual([])
    } finally { store.dispose() }
  })
})

describe("retained log bridge", () => {
  it("passes opaque computer and sandbox identities and rejects malformed pages", async () => {
    const mock = native()
    const invoke = vi.fn(async () => ({ entries: "not a log page" }))
    const store = createProductionSource({ ...mock.bridge, invoke } as unknown as ProductionBridge)
    const request = { sandboxId: "sandbox-id", computerId: "office-id", query: "old failure", limit: 200 }
    await expect(store.applicationActions.queryLogs!(request)).rejects.toThrow()
    expect(invoke).toHaveBeenCalledWith("query_sandbox_logs", { request })
    store.dispose()
  })
  it("distinguishes a canceled native export from a saved export and validates the reply", async () => {
    const mock = native()
    const invoke = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce("yes")
    const store = createProductionSource({ ...mock.bridge, invoke } as ProductionBridge)
    const requests = [{ sandboxId: "sandbox-id", query: "failure" }]
    expect(await store.applicationActions.exportLogs!(requests)).toBe(false)
    expect(await store.applicationActions.exportLogs!(requests)).toBe(true)
    await expect(store.applicationActions.exportLogs!(requests)).rejects.toThrow()
    expect(invoke).toHaveBeenCalledWith("export_workspace_logs", { requests })
    store.dispose()
  })
})
