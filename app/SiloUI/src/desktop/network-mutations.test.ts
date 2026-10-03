import { afterEach, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteWorkspaceTarget } from "@/features/application/model/connections"
import type { NetworkState } from "@/features/application/model/application-source"
import { assertNativeBridgeMocksHandled, nativeBridgeMock } from "@/test/native-bridge-mock"
import { createProductionSource, type ProductionBridge } from "./production-source"

afterEach(assertNativeBridgeMocksHandled)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
function row(workspace: string, hostPort: number): NetworkState["workspaces"][number] {
  return { workspace, error: null, ports: [{ port: 3000, hostPort, scheme: "http", configured: true, state: "reachable" }] }
}
function setup() {
  const local = applicationSourceForScenario("running")
  const name = local.workspaces[0].machine.name
  const other = local.workspaces[1].machine.name
  const remote = remoteWorkspaceTarget("office", local.workspaces[0].machine.id)
  const pending = [deferred<NetworkState>(), deferred<NetworkState>()]
  let localState = { workspaces: [row(name, 3000), row(other, 3001)] }
  const invoke = nativeBridgeMock({
    read_application_state: () => local,
    read_backup_state: () => ({ snapshotId: "fixture", availability: "available", archives: [], operation: null }),
    read_operation_queue: () => ({ running: [], waiting: [] }),
    read_setup_activity: () => [],
    device_list: () => [{ id: "office", name: "Office", address: "user@office" }],
    device_snapshot: () => local,
    connections_status: () => ({ enabled: false, deviceId: "local", name: "Laptop", address: "user@laptop" }),
    read_network_state: () => localState,
    remote_network_state: () => ({ workspaces: [row(remote, 4300)] }),
    save_network_port: args => pending[args?.hostPort === 4100 ? 0 : 1].promise,
    remote_save_network_port: () => pending[1].promise,
    remove_network_port: () => pending[1].promise,
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  const save = (workspace: string, hostPort: number) => store.applicationActions.saveNetworkPort!({ workspace, hostPort, port: 3000, scheme: "http" })
  const port = (target: string) => store.getSnapshot().source!.network!.workspaces.find(item => item.workspace === target)?.ports[0]?.hostPort
  return { store, name, other, remote, pending, save, port, invoke, authoritative: (state: NetworkState) => { localState = state } }
}

it.each([false, true])("preserves saves to different devices in either completion order (remote first: %s)", async remoteFirst => {
  const fixture = setup()
  const { store, name, remote, pending, save, port } = fixture
  try {
    await store.initialize(); await store.applicationActions.refreshNetwork!()
    const saves = [save(name, 4100), save(remote, 4400)]
    const results = [{ workspaces: [row(name, 4100)] }, { workspaces: [row(remote, 4400)] }]
    for (const index of remoteFirst ? [1, 0] : [0, 1]) { pending[index].resolve(results[index]); await saves[index] }
    expect(port(name)).toBe(4100)
    expect(port(remote)).toBe(4400)
  } finally { store.dispose() }
})

it("preserves independent sandbox saves on the same device despite stale sibling rows", async () => {
  const { store, name, other, pending, save, port } = setup()
  try {
    await store.initialize(); await store.applicationActions.refreshNetwork!()
    const first = save(name, 4100)
    const second = save(other, 4200)
    pending[1].resolve({ workspaces: [row(name, 3000), row(other, 4200)] }); await second
    pending[0].resolve({ workspaces: [row(name, 4100), row(other, 3001)] }); await first
    expect(port(name)).toBe(4100)
    expect(port(other)).toBe(4200)
  } finally { store.dispose() }
})

it.each(["save", "remove"])("rejects an older same-sandbox save after a newer %s and confirms authoritative state", async action => {
  const { store, name, pending, save, port, invoke, authoritative } = setup()
  try {
    await store.initialize(); await store.applicationActions.refreshNetwork!()
    const first = save(name, 4100)
    const second = action === "save" ? save(name, 4200) : store.applicationActions.removeNetworkPort!(name, 3000)
    const latest: NetworkState = { workspaces: [action === "save" ? row(name, 4200) : { workspace: name, error: null, ports: [] }] }
    authoritative(latest)
    pending[1].resolve(latest); await second
    const reads = invoke.mock.calls.filter(([command]) => command === "read_network_state").length
    pending[0].resolve({ workspaces: [row(name, 4100)] }); await first
    expect(port(name)).toBe(action === "save" ? 4200 : undefined)
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "read_network_state").length).toBeGreaterThan(reads))
    expect(port(name)).toBe(action === "save" ? 4200 : undefined)
  } finally { store.dispose() }
})
