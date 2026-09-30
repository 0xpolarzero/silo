import { afterEach, describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { createProductionSource, type ProductionBridge } from "./production-source"

import { assertNativeBridgeMocksHandled, nativeBridgeMock } from "@/test/native-bridge-mock"

afterEach(assertNativeBridgeMocksHandled)

const pushTarget = { repository: "owner/repo", branch: "main", commit: "a".repeat(40) }

function initializationHandlers() {
  return {
    read_backup_state: () => ({ snapshotId: "remote-fixture", availability: "available", requiredSpaceGB: 0, availableSpaceGB: 40, archives: [], operation: null }),
    read_operation_queue: () => ({ running: [], waiting: [] }),
  }
}

describe("remote computer ownership", () => {
  it("keeps same-name VMs distinct and directs a remote lifecycle action to its owner", async () => {
    const local = applicationSourceForScenario("running")
    const remote = structuredClone(local)
    remote.workspaces = [remote.workspaces[0]]
    local.workspaces[0].logs = [{ line: "Local VM log", occurredAt: "now" }]
    remote.workspaces[0].logs = [{ line: "Remote VM log", occurredAt: "now" }]
    remote.workspaces.push({ ...remote.workspaces[0], machine: { id: "00000000-0000-4000-8000-000000000099", kind: "ssh", name: "legacy-ssh", host: "legacy.example", user: "developer", port: 22 } })
    const computer = { id: "office", name: "Office Mac", address: "developer@office" }
    const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: () => local,
      remote_host_list: () => [computer],
      remote_host_snapshot: () => remote,
      remote_workspace_action: () => ({ ...remote, workspaces: remote.workspaces.map(workspace => ({ ...workspace, logs: [] })) }),
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "developer@laptop" }),
      read_setup_activity: () => [],
      read_network_state: () => ({ workspaces: [] }),
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
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("remote_workspace_action", { hostId: "office", vmId: remote.workspaces[0].machine.id, action: "stop", name: remote.workspaces[0].machine.name }))
      expect(invoke).not.toHaveBeenCalledWith("workspace_action", expect.anything())
      await vi.waitFor(() => expect(store.getSnapshot().source?.workspaces).toHaveLength(local.workspaces.length + 1))
      expect(observedRemoteLogs).not.toContain("Local VM log")
      unsubscribe()
    } finally { store.dispose() }
  })

  it("strips UI-qualified identities from optimistic remote edit and deletion requests", async () => {
    const local = applicationSourceForScenario("running")
    const machine = local.workspaces[0].machine
    const invoke = nativeBridgeMock({
      remote_upsert_machine: () => local,
      remote_delete_machine: () => local,
      remote_host_list: () => [],
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "developer@laptop" }),
    })
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
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: () => local,
      remote_host_list: () => [computer],
      remote_host_snapshot: async () => { if (disconnected) throw new Error("Connection lost"); return remote },
      remote_workspace_action: async () => { disconnected = true; throw new Error("Connection lost") },
      workspace_action: () => local,
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: () => ({ workspaces: [] }),
      read_setup_activity: () => [],
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
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: () => local,
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: () => remote,
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: async () => {
      if (networkFailure) throw new Error("Network check failed")
      return { workspaces: [{ workspace: local.workspaces[0].machine.name, error: null, ports: [{ port: 3000, hostPort: 3000, scheme: "http", configured: true, state: "reachable" }] }] }
    },
      remote_network_state: () => ({ workspaces: [{ workspace: target, error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", configured: true, state: "reachable" }] }] }),
      remote_save_network_port: () => ({ workspaces: [{ workspace: target, error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", configured: true, state: "reachable" }] }] }),
      remote_remove_network_port: () => ({ workspaces: [{ workspace: target, error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", configured: true, state: "reachable" }] }] }),
      read_setup_activity: () => [],
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
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: () => local,
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: async () => {
      if (busy) throw { code: "update_in_progress", message: "Please wait for configuration." }
      return local
    },
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: () => ({ workspaces: [] }),
      remote_network_state: () => ({ workspaces: [] }),
      read_setup_activity: () => [],
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
    expect(workspace.stateDetail).toBe("Updating…")
  } finally { store.dispose() }
})

it("preserves connected remote VMs when later local state reads fail", async () => {
  const local = applicationSourceForScenario("running")
  let failLocal = false
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: async () => { if (failLocal) throw new Error("Local runtime unavailable"); return local },
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: () => local,
      remote_workspace_action: () => local,
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: () => ({ workspaces: [] }),
      remote_network_state: () => ({ workspaces: [] }),
      read_setup_activity: () => [],
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
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("remote_workspace_action", { hostId: "office", vmId: local.workspaces[0].machine.id, action: "stop", name: expect.anything() }))
  } finally { store.dispose() }
})

it("uses native local metadata to display verified remote VMs when local runtime fails at startup", async () => {
  const remote = applicationSourceForScenario("running")
  const shell = { ...remote, workspaces: [], runtimeRepair: { status: "unavailable", reason: "Local runtime unavailable" } }
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: async () => { throw new Error("Local runtime unavailable") },
      read_application_shell: () => shell,
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: () => remote,
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: () => ({ workspaces: [] }),
      remote_network_state: () => ({ workspaces: [] }),
      read_setup_activity: () => [],
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
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: () => local,
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: () => remote,
      start_repository_push: () => remote.repositoryPushOperations![0],
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: () => ({ workspaces: [] }),
      remote_network_state: () => ({ workspaces: [] }),
      read_setup_activity: () => [],
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
    store.applicationActions.pushRepository(target, "/workspace/repo", pushTarget)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("start_repository_push", { workspace: target, repositoryPath: "/workspace/repo", operationId: expect.any(String), target: pushTarget }))
  } finally { store.dispose() }
})

it.each(["succeeded", "failed"] as const)("keeps a remote push loading across refreshes until its %s result arrives", async status => {
  const local = applicationSourceForScenario("running")
  const remote = structuredClone(local)
  remote.workspaces = [remote.workspaces[0]]
  const workspace = remoteWorkspaceTarget("office", remote.workspaces[0].machine.id)
  const repositoryPath = remote.workspaces[0].repositories[0].path
  let finishPush!: (result: unknown) => void
  const pending = new Promise(resolve => { finishPush = resolve })
  let finishStaleRead: ((result: unknown) => void) | undefined
  let holdRemoteRead = false
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: () => local,
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: () => holdRemoteRead ? new Promise(resolve => { finishStaleRead = resolve }) : remote,
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: () => ({ workspaces: [] }),
      remote_network_state: () => ({ workspaces: [] }),
      read_setup_activity: () => [],
      start_repository_push: () => pending,
    })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    store.applicationActions.pushRepository(workspace, repositoryPath, pushTarget)
    const pushing = { workspace, repositoryPath, commitCount: remote.workspaces[0].repositories[0].ahead, status: "pushing" }
    expect(store.getSnapshot().source!.repositoryPushOperations).toContainEqual(pushing)
    const remoteReads = invoke.mock.calls.filter(([command]) => command === "remote_host_snapshot").length
    await store.refresh()
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "remote_host_snapshot").length).toBeGreaterThan(remoteReads))
    await store.applicationActions.refreshNetwork!()
    expect(store.getSnapshot().source!.repositoryPushOperations).toContainEqual(pushing)
    store.applicationActions.pushRepository(workspace, repositoryPath, pushTarget)
    expect(invoke.mock.calls.filter(([command]) => command === "start_repository_push")).toHaveLength(1)
    holdRemoteRead = true
    await store.refresh()
    await vi.waitFor(() => expect(finishStaleRead).toBeDefined())
    const staleRemote = structuredClone(remote)
    const result = { workspace: remote.workspaces[0].machine.name, repositoryPath, commitCount: 2, ...(status === "failed" ? { status, message: "Missing LFS object" } : { status }) }
    remote.repositoryPushOperations = [result]
    finishPush(result)
    await vi.waitFor(() => expect(store.getSnapshot().source!.repositoryPushOperations).toContainEqual({ ...result, workspace }))
    holdRemoteRead = false
    finishStaleRead!(staleRemote)
    await store.applicationActions.refreshNetwork!()
    expect(store.getSnapshot().source!.repositoryPushOperations).toContainEqual({ ...result, workspace })
  } finally { store.dispose() }
})

it.each([true, false])("reconciles a lost start reply without another push (host accepted: %s)", async accepted => {
  const local = applicationSourceForScenario("running")
  const remote = structuredClone(local)
  remote.workspaces = [remote.workspaces[0]]
  const workspace = remoteWorkspaceTarget("office", remote.workspaces[0].machine.id)
  const repositoryPath = remote.workspaces[0].repositories[0].path
  let attempts = 0
  const success = { workspace: remote.workspaces[0].machine.name, repositoryPath, status: "succeeded" as const, commitCount: 2 }
  const invoke = nativeBridgeMock({
      ...initializationHandlers(),
      read_application_state: () => local,
      remote_host_list: () => [{ id: "office", name: "Office Mac", address: "user@office" }],
      remote_host_snapshot: () => remote,
      remote_management_status: () => ({ enabled: false, hostId: "local", name: "Laptop", address: "user@laptop" }),
      read_network_state: () => ({ workspaces: [] }),
      remote_network_state: () => ({ workspaces: [] }),
      read_setup_activity: () => [],
      start_repository_push: async () => {
      if (++attempts === 1) throw new Error("SSH connection closed")
      remote.repositoryPushOperations = [success]
      return success
    },
      repository_push_status: async () => {
      if (accepted) remote.repositoryPushOperations = [success]
      return accepted ? success : null
    },
    })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    store.applicationActions.pushRepository(workspace, repositoryPath, pushTarget)
    await vi.waitFor(() => expect(store.getSnapshot().source!.repositoryPushOperations).toContainEqual(expect.objectContaining({ status: "pushing", message: expect.stringContaining("Waiting for push status") })))
    store.applicationActions.pushRepository(workspace, repositoryPath, pushTarget)
    expect(attempts).toBe(1)
    await vi.waitFor(() => expect(store.getSnapshot().source!.repositoryPushOperations).toContainEqual({ workspace, repositoryPath, status: "succeeded", commitCount: 2 }), { timeout: 4_000 })
    expect(attempts).toBe(accepted ? 1 : 2)
    const calls = invoke.mock.calls as unknown as Array<[string, { operationId?: string }]>
    const requestIds = calls.filter(([command]) => command === "start_repository_push" || command === "repository_push_status").map(([, args]) => args.operationId)
    expect(new Set(requestIds).size).toBe(1)
    expect(requestIds[0]).toEqual(expect.any(String))
  } finally { store.dispose() }
})
