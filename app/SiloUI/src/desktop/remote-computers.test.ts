import { describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { createProductionSource, type ProductionBridge } from "./production-source"

describe("remote computer ownership", () => {
  it("keeps same-name VMs distinct and directs a remote lifecycle action to its owner", async () => {
    const local = applicationSourceForScenario("running")
    const remote = structuredClone(local)
    remote.workspaces = [remote.workspaces[0]]
    local.workspaces[0].logs = [{ line: "Local VM log", occurredAt: "now" }]
    remote.workspaces[0].logs = [{ line: "Remote VM log", occurredAt: "now" }]
    remote.workspaces.push({ ...remote.workspaces[0], machine: { id: "00000000-0000-4000-8000-000000000099", kind: "ssh", name: "legacy-ssh", host: "legacy.example", user: "developer", port: 22 } })
    const computer = { id: "office", name: "Office Mac", address: "developer@office" }
    const invoke = vi.fn(async (command: string) => {
      if (command === "read_application_state") return local
      if (command === "remote_host_list") return [computer]
      if (command === "remote_host_snapshot") return remote
      if (command === "remote_workspace_action") return { ...remote, workspaces: remote.workspaces.map(workspace => ({ ...workspace, logs: [] })) }
      if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "developer@laptop" }
      if (command === "read_setup_activity") return []
      if (command === "read_network_state") return { workspaces: [] }
      return undefined
    })
    const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
    try {
      await store.initialize()
      const target = remoteWorkspaceTarget(computer.id, remote.workspaces[0].machine.id)
      expect(store.getSnapshot().source!.workspaces.some(workspace => workspace.machine.name === "legacy-ssh")).toBe(false)
      const names = store.getSnapshot().source!.workspaces.filter(workspace => workspace.machine.name === remote.workspaces[0].machine.name)
      expect(names).toHaveLength(2)
      expect(names[0].machine.id).not.toBe(names[1].machine.id)
      const observedRemoteLogs: string[] = []
      const unsubscribe = store.subscribe(() => observedRemoteLogs.push(...(store.getSnapshot().source?.workspaces.find(workspace => workspace.computer)?.logs.map(log => log.line) ?? [])))
      store.applicationActions.stopWorkspace(target)
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("remote_workspace_action", { hostId: "office", vmId: remote.workspaces[0].machine.id, action: "stop" }))
      expect(invoke).not.toHaveBeenCalledWith("workspace_action", expect.anything())
      await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces).toHaveLength(local.workspaces.length + 1))
      expect(observedRemoteLogs).not.toContain("Local VM log")
      unsubscribe()
    } finally { store.dispose() }
  })

  it("strips UI-qualified identities from optimistic remote edit and deletion requests", async () => {
    const local = applicationSourceForScenario("running")
    const machine = local.workspaces[0].machine
    const invoke = vi.fn(async () => local)
    const store = createProductionSource({ invoke, listen: async () => () => {} } as unknown as ProductionBridge)
    const displayed = { ...machine, id: remoteWorkspaceTarget("office", machine.id) }
    try {
      await store.applicationActions.saveRemoteMachine!("office", displayed, displayed)
      expect(invoke).toHaveBeenCalledWith("remote_upsert_machine", { hostId: "office", machine, expected: machine })
      await store.applicationActions.deleteRemoteMachine!("office", displayed)
      expect(invoke).toHaveBeenCalledWith("remote_delete_machine", { hostId: "office", vmId: machine.id, expected: machine })
    } finally { store.dispose() }
  })
})

it("keeps local state fresh after remote lifecycle failure and launches editors on the controlling computer", async () => {
  const local = applicationSourceForScenario("running")
  const remote = structuredClone(local)
  remote.workspaces = [remote.workspaces[0]]
  const computer = { id: "office", name: "Office Mac", address: "user@office" }
  const target = remoteWorkspaceTarget(computer.id, remote.workspaces[0].machine.id)
  let disconnected = false
  const invoke = vi.fn(async (command: string) => {
    if (command === "read_application_state") return local
    if (command === "remote_host_list") return [computer]
    if (command === "remote_host_snapshot") { if (disconnected) throw new Error("Connection lost"); return remote }
    if (command === "remote_workspace_action") { disconnected = true; throw new Error("Connection lost") }
    if (command === "workspace_action") return local
    if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }
    if (command === "read_network_state") return { workspaces: [] }
    if (command === "read_setup_activity") return []
    return undefined
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    store.applicationActions.openEditor(target, "/workspace/project")
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("workspace_action", { action: "open-editor", name: target, path: "/workspace/project" }))
    await new Promise(resolve => setTimeout(resolve, 0))
    store.applicationActions.stopWorkspace(target)
    await vi.waitFor(() => expect(store.getSnapshot().source!.workspaces.find(workspace => workspace.computer)?.freshness).toBe("stale"))
    expect(store.getSnapshot().source!.workspaces.filter(workspace => !workspace.computer).every(workspace => workspace.freshness === "fresh")).toBe(true)
    expect(store.getSnapshot().source!.vmOperationsUnavailable).toBeUndefined()
  } finally { store.dispose() }
})

it("uses qualified remote port mappings and revokes reachability after a failed network refresh", async () => {
  const local = applicationSourceForScenario("running")
  const remote = structuredClone(local)
  remote.workspaces = [remote.workspaces[0]]
  const target = remoteWorkspaceTarget("office", remote.workspaces[0].machine.id)
  let networkFailure = false
  const invoke = vi.fn(async (command: string) => {
    if (command === "read_application_state") return local
    if (command === "remote_host_list") return [{ id: "office", name: "Office Mac", address: "user@office" }]
    if (command === "remote_host_snapshot") return remote
    if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }
    if (command === "read_network_state") {
      if (networkFailure) throw new Error("Network check failed")
      return { workspaces: [{ workspace: local.workspaces[0].machine.name, error: null, ports: [{ port: 3000, hostPort: 3000, scheme: "http", configured: true, state: "reachable" }] }] }
    }
    if (command === "remote_network_state" || command === "remote_save_network_port" || command === "remote_remove_network_port") return { workspaces: [{ workspace: target, error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", configured: true, state: "reachable" }] }] }
    if (command === "read_setup_activity") return []
    return undefined
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    await store.applicationActions.refreshNetwork!()
    expect(store.getSnapshot().source!.workspaces.find(workspace => workspace.computer)?.ports).toEqual([{ port: 3000, hostPort: 43000, scheme: "http", configured: true, listening: true }])
    expect(invoke).toHaveBeenCalledWith("remote_network_state", { hostId: "office" })
    expect(store.getSnapshot().source!.workspaces.find(workspace => !workspace.computer)?.ports[0].hostPort).toBe(3000)
    await store.applicationActions.saveNetworkPort!({ workspace: target, port: 3000, hostPort: 43000, scheme: "http" })
    expect(invoke).toHaveBeenCalledWith("remote_save_network_port", { hostId: "office", vmId: remote.workspaces[0].machine.id, port: 3000, hostPort: 43000, scheme: "http" })
    expect(store.getSnapshot().source!.network!.workspaces.map(row => row.workspace)).toEqual([local.workspaces[0].machine.name, target])
    await store.applicationActions.removeNetworkPort!(target, 3000)
    expect(invoke).toHaveBeenCalledWith("remote_remove_network_port", { hostId: "office", vmId: remote.workspaces[0].machine.id, port: 3000 })
    networkFailure = true
    await store.applicationActions.refreshNetwork!()
    expect(store.getSnapshot().source!.workspaces.find(workspace => workspace.computer)?.ports[0].listening).toBe(false)
  } finally { store.dispose() }
})

it("keeps a reachable computer connected while its VM configuration is busy", async () => {
  const local = applicationSourceForScenario("running")
  let busy = false
  const invoke = vi.fn(async (command: string) => {
    if (command === "read_application_state") return local
    if (command === "remote_host_list") return [{ id: "office", name: "Office Mac", address: "user@office" }]
    if (command === "remote_host_snapshot") {
      if (busy) throw new Error("SILO_SANDBOX_UPDATE_IN_PROGRESS")
      return local
    }
    if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }
    if (command === "read_network_state" || command === "remote_network_state") return { workspaces: [] }
    if (command === "read_setup_activity") return []
    return undefined
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    busy = true
    await store.refresh()
    await vi.waitFor(() => expect(store.getSnapshot().source!.remoteComputers![0].busy).toBe(true))
    const workspace = store.getSnapshot().source!.workspaces.find(workspace => workspace.computer)!
    expect(workspace.computer!.connected).toBe(true)
    expect(workspace.freshness).toBe("stale")
    expect(workspace.stateDetail).toBe("Applying VM changes")
  } finally { store.dispose() }
})

it("preserves connected remote VMs when later local state reads fail", async () => {
  const local = applicationSourceForScenario("running")
  let failLocal = false
  const invoke = vi.fn(async (command: string) => {
    if (command === "read_application_state") { if (failLocal) throw new Error("Local runtime unavailable"); return local }
    if (command === "remote_host_list") return [{ id: "office", name: "Office Mac", address: "user@office" }]
    if (command === "remote_host_snapshot" || command === "remote_workspace_action") return local
    if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }
    if (command === "read_network_state" || command === "remote_network_state") return { workspaces: [] }
    if (command === "read_setup_activity") return []
    return undefined
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    failLocal = true
    await store.refresh()
    const source = store.getSnapshot().source!
    expect(source.vmOperationsUnavailable).toContain("Local runtime unavailable")
    expect(source.workspaces.find(workspace => !workspace.computer)?.freshness).toBe("stale")
    const remote = source.workspaces.find(workspace => workspace.computer)!
    expect(remote.freshness).toBe("fresh")
    store.applicationActions.stopWorkspace(remote.machine.id)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("remote_workspace_action", { hostId: "office", vmId: local.workspaces[0].machine.id, action: "stop" }))
  } finally { store.dispose() }
})

it("uses native local metadata to display verified remote VMs when local runtime fails at startup", async () => {
  const remote = applicationSourceForScenario("running")
  const shell = { ...remote, workspaces: [], runtimeRepair: { status: "unavailable", reason: "Local runtime unavailable" } }
  const invoke = vi.fn(async (command: string) => {
    if (command === "read_application_state") throw new Error("Local runtime unavailable")
    if (command === "read_application_shell") return shell
    if (command === "remote_host_list") return [{ id: "office", name: "Office Mac", address: "user@office" }]
    if (command === "remote_host_snapshot") return remote
    if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }
    if (command === "read_network_state" || command === "remote_network_state") return { workspaces: [] }
    if (command === "read_setup_activity") return []
    return undefined
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces).toHaveLength(remote.workspaces.length))
    expect(invoke).toHaveBeenCalledWith("read_application_shell", { error: "Silo could not read application state: Local runtime unavailable" })
    expect(store.getSnapshot().source!.workspaces.every(workspace => workspace.computer?.id === "office" && workspace.freshness === "fresh")).toBe(true)
    expect(store.getSnapshot().source!.runtimeRepair?.reason).toBe("Local runtime unavailable")
  } finally { store.dispose() }
})

it("merges remote repository results and activity idempotently without same-name collisions", async () => {
  const local = applicationSourceForScenario("running")
  const remote = structuredClone(local)
  remote.workspaces = [remote.workspaces[0]]
  const name = local.workspaces[0].machine.name
  const target = remoteWorkspaceTarget("office", remote.workspaces[0].machine.id)
  local.repositoryPushOperations = [{ workspace: name, repositoryPath: "/workspace/repo", commitCount: 1, status: "succeeded" }]
  remote.repositoryPushOperations = [{ workspace: name, repositoryPath: "/workspace/repo", commitCount: 2, status: "failed", message: "Remote push failed" }]
  remote.activities = [{ ...local.activities[0], workspace: name, title: "Remote start" }]
  remote.github.account = "remote-owner"
  remote.secrets = []
  const invoke = vi.fn(async (command: string) => {
    if (command === "read_application_state") return local
    if (command === "remote_host_list") return [{ id: "office", name: "Office Mac", address: "user@office" }]
    if (command === "remote_host_snapshot") return remote
    if (command === "remote_management_status") return { enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }
    if (command === "read_network_state" || command === "remote_network_state") return { workspaces: [] }
    if (command === "read_setup_activity") return []
    return undefined
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    await store.applicationActions.refreshNetwork!()
    await store.applicationActions.refreshNetwork!()
    const source = store.getSnapshot().source!
    expect(source.repositoryPushOperations).toEqual([local.repositoryPushOperations[0], { ...remote.repositoryPushOperations[0], workspace: target }])
    expect(source.activities).toHaveLength(local.activities.length + 1)
    expect(new Set(source.activities.map(activity => activity.id)).size).toBe(source.activities.length)
    expect(source.activities.find(activity => activity.title === "Remote start")).toMatchObject({ workspace: target, detail: expect.stringContaining("Office Mac:") })
    expect(source.github).toMatchObject(local.github)
    expect(source.secrets).toEqual(local.secrets)
    store.applicationActions.pushRepository(target, "/workspace/repo")
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("push_repository", { workspace: target, repositoryPath: "/workspace/repo" }))
  } finally { store.dispose() }
})
