import { describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createProductionSource, type ProductionBridge } from "./production-source"

const application = applicationSourceForScenario("running")
const machine = application.workspaces[0].machine
const request = {
  machineConfiguration: { schemaVersion: 1 as const, machines: [machine] },
  github: { connectionState: "disconnected" as const, workspaces: [{ workspace: machine.name, repositories: [], identity: { name: "Test", email: "test@example.invalid", apply: true } }] },
}
const statuses = (store: ReturnType<typeof createProductionSource>) => store.getSnapshot().setupQueue.filter(({ id }) => id.startsWith("identity")).map(({ status }) => status)
function setup() {
  const verify = vi.fn<() => Promise<unknown>>().mockResolvedValue(true)
  const invoke = vi.fn(async (command: string) => {
    if (command === "verify_workspace_identities") return verify()
    if (command === "save_machine_configuration") return application
    if (command === "read_setup_activity") return []
    throw new Error(`Unexpected ${command}`)
  })
  return { verify, invoke, store: createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge) }
}
describe("identity completion after relaunch", () => {
  it("restores completion only from a successful native read, without changing a VM", async () => {
    const { store, invoke } = setup()
    expect(statuses(store)).toEqual(["idle", "idle"])
    await store.verifySetupIdentities(request)
    expect(statuses(store)).toEqual(["succeeded", "succeeded"])
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["verify_workspace_identities"])
  })
  it.each([false, "true", null])("does not accept missing, mismatching or malformed results: %s", async (result) => {
    const { store, verify } = setup()
    verify.mockResolvedValue(result)
    await store.verifySetupIdentities(request)
    expect(statuses(store)).toEqual(["idle", "idle"])
  })
  it("does not accept a failed read", async () => {
    const { store, verify } = setup()
    verify.mockRejectedValue(new Error("Runtime unavailable"))
    await store.verifySetupIdentities(request)
    expect(statuses(store)).toEqual(["idle", "idle"])
  })
  it("ignores a stale successful read after the author changes", async () => {
    const { store, verify } = setup()
    let resolve!: (value: boolean) => void
    verify.mockReturnValueOnce(new Promise<boolean>((done) => { resolve = done })).mockResolvedValue(false)
    const old = store.verifySetupIdentities(request)
    const edited = structuredClone(request)
    edited.github.workspaces[0].identity.name = "Edited"
    await store.verifySetupIdentities(edited)
    resolve(true)
    await old
    expect(statuses(store)).toEqual(["idle", "idle"])
  })
  it("ignores a stale successful read after sandbox setup starts", async () => {
    const { store, verify } = setup()
    let resolve!: (value: boolean) => void
    verify.mockReturnValueOnce(new Promise<boolean>((done) => { resolve = done }))
    const old = store.verifySetupIdentities(request)
    await store.configureMachines(request.machineConfiguration)
    resolve(true)
    await old
    expect(statuses(store)).toEqual(["idle", "idle"])
  })
  it("checks a draft edited during setup after that setup finishes", async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    const verify = vi.fn().mockResolvedValue(false)
    const store = createProductionSource({
      invoke: async (command: string) => {
        if (command === "save_machine_configuration") return pending
        if (command === "read_setup_activity") return []
        if (command === "configure_workspace_identities") return undefined
        if (command === "verify_workspace_identities") return verify()
        throw new Error(command)
      }, listen: async () => () => {},
    } as ProductionBridge)
    const job = store.submitSetupStep("github", { ...request, applications: application.preferences })
    const edited = structuredClone(request)
    edited.github.workspaces[0].identity.name = "Edited"
    const check = store.verifySetupIdentities(edited)
    expect(verify).not.toHaveBeenCalled()
    finish(application)
    await Promise.all([job, check])
    expect(verify).toHaveBeenCalledOnce()
    expect(statuses(store)).toEqual(["idle", "idle"])
  })
  it("does not recheck unchanged identities for unrelated draft updates", async () => {
    const { store, verify } = setup()
    await store.verifySetupIdentities(request)
    await store.verifySetupIdentities(structuredClone(request))
    expect(verify).toHaveBeenCalledOnce()
  })
})
