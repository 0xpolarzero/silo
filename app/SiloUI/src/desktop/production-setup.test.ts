import { describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { OnboardingCompletionRequest } from "@/features/onboarding/model/onboarding-source"
import { createProductionSource, type ProductionBridge } from "./production-source"

const application = applicationSourceForScenario("running")
const request: OnboardingCompletionRequest = {
  machineConfiguration: { schemaVersion: 1, machines: [application.workspaces[0].machine] },
  applications: application.preferences,
  github: { connectionState: "disconnected", workspaces: [{ workspace: application.workspaces[0].machine.name, repositories: [], identity: { name: "Test", email: "test@example.invalid", apply: true } }] },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function setup() {
  const machines = vi.fn<() => Promise<unknown>>().mockResolvedValue(application)
  const identities = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined)
  const events = new Map<string, (event?: { payload: unknown }) => void>()
  const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
    if (command === "read_application_state") return application
    if (command === "read_backup_state") return { snapshotId: "test", availability: "available", archives: [], operation: null }
    if (command === "save_machine_configuration") return machines()
    if (command === "configure_workspace_identities") return identities()
    throw new Error(`Unexpected command ${command}`)
  })
  const bridge = { invoke, listen: async (name: string, handler: (event?: { payload: unknown }) => void) => { events.set(name, handler); return () => events.delete(name) } } as ProductionBridge
  const store = createProductionSource(bridge)
  await store.initialize()
  return { store, machines, identities, invoke, emit: (payload: unknown) => events.get("silo://machine-configuration-progress")?.({ payload }) }
}

describe("production setup queue", () => {
  it("starts idle, coalesces duplicate Continue, and waits before applying identity", async () => {
    const { store, machines, identities } = await setup()
    expect(store.getSnapshot().setupQueue.every(({ status }) => status === "idle")).toBe(true)
    const pending = deferred<unknown>()
    machines.mockReturnValueOnce(pending.promise)
    const first = store.submitSetupStep("workspaces", request)
    const duplicate = store.submitSetupStep("workspaces", structuredClone(request))
    const github = store.submitSetupStep("github", request)
    await vi.waitFor(() => expect(machines).toHaveBeenCalledOnce())
    expect(identities).not.toHaveBeenCalled()
    expect(store.getSnapshot().setupQueue.find(({ id }) => id === "identityRun")?.status).toBe("queued")
    pending.resolve(application)
    await Promise.all([first, duplicate, github])
    expect(machines).toHaveBeenCalledOnce()
    expect(identities).toHaveBeenCalledOnce()
    store.dispose()
  })

  it("fails dependent work without calling identity and retries failed machine jobs", async () => {
    const { store, machines, identities } = await setup()
    const pending = deferred<unknown>()
    machines.mockReturnValueOnce(pending.promise)
    const markComplete = vi.fn(async () => {})
    const result = expect(store.finishSetup(request, markComplete)).rejects.toThrow("disk unavailable")
    await vi.waitFor(() => expect(machines).toHaveBeenCalledOnce())
    pending.reject(new Error("disk unavailable"))
    await result
    expect(identities).not.toHaveBeenCalled()
    expect(markComplete).not.toHaveBeenCalled()
    expect(store.getSnapshot().setupQueue.find(({ id }) => id === "workspaceRun")?.status).toBe("failed")
    expect(store.getSnapshot().setupQueue.find(({ id }) => id === "identityRun")?.status).toBe("failed")
    await store.finishSetup(request, markComplete)
    expect(machines).toHaveBeenCalledTimes(2)
    expect(identities).toHaveBeenCalledOnce()
    expect(markComplete).toHaveBeenCalledOnce()
    store.dispose()
  })

  it("accepts correlated native progress and ignores stale or completed requests", async () => {
    const { store, machines, invoke, emit } = await setup()
    const pending = deferred<unknown>()
    machines.mockReturnValueOnce(pending.promise)
    const job = store.submitSetupStep("workspaces", request)
    await vi.waitFor(() => expect(machines).toHaveBeenCalledOnce())
    const requestId = invoke.mock.calls.find(([command]) => command === "save_machine_configuration")?.[1]?.requestId
    const event = { schemaVersion: 1, type: "progress", requestId, phase: "verification", step: "workspace-verification", workspace: request.machineConfiguration.machines[0].name, revision: "a".repeat(64), fraction: 0.5, message: "Checking VM", safeForDisplay: true }
    emit({ ...event, requestId: "old-request" })
    expect(store.getSnapshot().setupEvents).toEqual([])
    emit(event)
    expect(store.getSnapshot().setupEvents).toEqual([event])
    expect(store.getSnapshot().setupQueue.find(({ id }) => id === "workspaceVerify")?.status).toBe("running")
    pending.resolve(application)
    await job
    emit({ ...event, message: "Late event" })
    expect(store.getSnapshot().setupEvents).toEqual([event])
    store.dispose()
  })

  it("marks completion only after identity succeeds and retries failed identity without recreating VMs", async () => {
    const { store, machines, identities } = await setup()
    const pending = deferred<unknown>()
    identities.mockReturnValueOnce(pending.promise)
    const markComplete = vi.fn(async () => {})
    const result = expect(store.finishSetup(request, markComplete)).rejects.toThrow("identity rejected")
    await vi.waitFor(() => expect(identities).toHaveBeenCalledOnce())
    expect(markComplete).not.toHaveBeenCalled()
    pending.reject(new Error("identity rejected"))
    await result
    expect(markComplete).not.toHaveBeenCalled()
    await store.finishSetup(request, markComplete)
    expect(machines).toHaveBeenCalledOnce()
    expect(identities).toHaveBeenCalledTimes(2)
    expect(markComplete).toHaveBeenCalledOnce()
    expect(store.getSnapshot().setupQueue.every(({ status }) => status === "succeeded")).toBe(true)
    store.dispose()
  })
  it("rejects repository selections before changing any VM", async () => {
    const { store, machines, identities } = await setup()
    const selected = structuredClone(request)
    selected.github.workspaces[0].repositories = [{ repository: "owner/repo", allowPushes: false }]
    const markComplete = vi.fn(async () => {})
    await expect(store.finishSetup(selected, markComplete)).rejects.toThrow("Repository setup is not available")
    expect(machines).not.toHaveBeenCalled()
    expect(identities).not.toHaveBeenCalled()
    expect(markComplete).not.toHaveBeenCalled()
    store.dispose()
  })

  it("keeps failed completion visible and retries only completion", async () => {
    const { store, machines, identities } = await setup()
    const markComplete = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("settings write failed")).mockResolvedValue(undefined)
    await expect(store.finishSetup(request, markComplete)).rejects.toThrow("settings write failed")
    expect(store.getSnapshot().setupQueue.find(({ id }) => id === "completion")).toMatchObject({ status: "failed", failure: "settings write failed" })
    await store.finishSetup(request, markComplete)
    expect(machines).toHaveBeenCalledOnce()
    expect(identities).toHaveBeenCalledOnce()
    expect(markComplete).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().setupQueue.find(({ id }) => id === "completion")?.status).toBe("succeeded")
    store.dispose()
  })

  it("drains accepted setup through completion and rejects new work while quitting", async () => {
    const { store, machines, identities } = await setup()
    const machine = deferred<unknown>()
    const identity = deferred<unknown>()
    const completion = deferred<void>()
    machines.mockReturnValueOnce(machine.promise)
    identities.mockReturnValueOnce(identity.promise)
    const markComplete = vi.fn(() => completion.promise)
    const finished = store.finishSetup(request, markComplete)
    let drained = false
    const drain = store.drainSetup().then(() => { drained = true })
    await expect(store.submitSetupStep("workspaces", request)).rejects.toThrow("quitting")
    await expect(store.finishSetup(request, markComplete)).rejects.toThrow("quitting")
    await vi.waitFor(() => expect(machines).toHaveBeenCalledOnce())
    expect(drained).toBe(false)
    expect(markComplete).not.toHaveBeenCalled()
    machine.resolve(application)
    await vi.waitFor(() => expect(identities).toHaveBeenCalledOnce())
    expect(drained).toBe(false)
    expect(markComplete).not.toHaveBeenCalled()
    identity.resolve(undefined)
    await vi.waitFor(() => expect(markComplete).toHaveBeenCalledOnce())
    expect(drained).toBe(false)
    completion.resolve(undefined)
    await Promise.all([finished, drain])
    expect(drained).toBe(true)
    expect(store.getSnapshot().setupQueue.every(({ status }) => status === "succeeded")).toBe(true)
    store.dispose()
  })

  it("does not show workspace success while a changed configuration is still queued", async () => {
    const { store, machines, identities } = await setup()
    const machineA = deferred<unknown>()
    const identityA = deferred<unknown>()
    machines.mockReturnValueOnce(machineA.promise)
    identities.mockReturnValueOnce(identityA.promise)
    const first = store.submitSetupStep("github", request)
    await vi.waitFor(() => expect(machines).toHaveBeenCalledOnce())
    const changed = structuredClone(request)
    changed.machineConfiguration.machines[0].name = "changed-vm"
    const second = store.submitSetupStep("workspaces", changed)
    machineA.resolve(application)
    await vi.waitFor(() => expect(identities).toHaveBeenCalledOnce())
    const workspaceStatuses = store.getSnapshot().setupQueue.filter(({ id }) => id === "workspaceRun" || id === "workspaceVerify").map(({ status }) => status)
    identityA.resolve(undefined)
    await Promise.all([first, second])
    store.dispose()
    expect(workspaceStatuses).not.toEqual(["succeeded", "succeeded"])
    expect(workspaceStatuses).toContain("queued")
  })

})
