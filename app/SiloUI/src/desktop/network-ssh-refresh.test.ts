import { afterEach, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteComputerTarget } from "@/features/application/model/connections"
import type { NetworkState, SshAccessState } from "@/features/application/model/application-source"
import { assertNativeBridgeMocksHandled, nativeBridgeMock } from "@/test/native-bridge-mock"
import { createProductionSource, type ProductionBridge } from "./production-source"

afterEach(() => { assertNativeBridgeMocksHandled(); vi.useRealTimers(); vi.restoreAllMocks() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}

function networkState(computer: string, hostPort = 3000): NetworkState {
  return { computers: [{ computer, error: null, ports: [{ port: 3000, hostPort, scheme: "http", configured: true, state: "reachable" }] }] }
}
function sshState(computer: string, enabled = true): SshAccessState {
  return { computers: [{ computer, enabled, port: 2222, bindAddress: "127.0.0.1", keys: [], state: enabled ? "listening" : "disabled", message: null, fingerprint: null, deviceName: "Fixture", addresses: ["127.0.0.1"] }] }
}

it.each([false, true])("publishes healthy owners while a remote stays pending and rejects late replies (save: %s)", async save => {
  vi.useFakeTimers()
  const local = applicationSourceForScenario("running")
  const name = local.computers[0].configuration.name
  const slow = remoteComputerTarget("slow", local.computers[0].configuration.id)
  const healthy = remoteComputerTarget("healthy", local.computers[0].configuration.id)
  const pendingNetwork = deferred<NetworkState>()
  const pendingSsh = deferred<SshAccessState>()
  let hold = false
  let hostPort = 3000
  let enabled = true
  const invoke = nativeBridgeMock({
    read_application_state: () => local,
    read_backup_state: () => ({ snapshotId: "fixture", availability: "available", archives: [], operation: null }),
    read_operation_queue: () => ({ running: [], waiting: [] }),
    read_setup_activity: () => [],
    device_list: () => ["slow", "healthy"].map(id => ({ id, name: id, address: `user@${id}` })),
    device_snapshot: () => local,
    connections_status: () => ({ enabled: false, deviceId: "local", name: "Laptop", address: "user@laptop" }),
    read_network_state: () => networkState(name, hostPort),
    remote_network_state: args => args?.deviceId === "slow" ? hold ? pendingNetwork.promise : networkState(slow) : networkState(healthy, hostPort),
    read_ssh_access_state: () => sshState(name, enabled),
    remote_ssh_access_state: args => args?.deviceId === "slow" ? hold ? pendingSsh.promise : sshState(slow) : sshState(healthy, enabled),
    remote_save_network_port: () => networkState(slow, 4200),
    remote_save_ssh_access: () => sshState(slow, false),
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  try {
    await store.initialize()
    await store.applicationActions.refreshNetwork!()
    await store.applicationActions.refreshSshAccess!()
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    hold = true; hostPort = 4100; enabled = false
    const networkRead = store.applicationActions.refreshNetwork!()
    const sshRead = store.applicationActions.refreshSshAccess!()
    await vi.advanceTimersByTimeAsync(0)
    for (const target of [name, healthy]) {
      expect(store.getSnapshot().source!.network!.computers.find(row => row.computer === target)?.ports[0].hostPort).toBe(4100)
      expect(store.getSnapshot().source!.sshAccess!.computers.find(row => row.computer === target)?.enabled).toBe(false)
    }
    hostPort = 4150; enabled = true
    const nextNetworkRead = store.applicationActions.refreshNetwork!()
    const nextSshRead = store.applicationActions.refreshSshAccess!()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().source!.network!.computers.find(row => row.computer === name)?.ports[0].hostPort).toBe(4150)
    expect(store.getSnapshot().source!.sshAccess!.computers.find(row => row.computer === name)?.enabled).toBe(true)
    if (save) {
      await store.applicationActions.saveNetworkPort!({ computer: slow, port: 3000, hostPort: 4200, scheme: "http" })
      await store.applicationActions.saveSshAccess!({ computer: slow, enabled: false, port: 2222, bindAddress: "127.0.0.1", keys: [] })
    }
    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.all([networkRead, nextNetworkRead, sshRead, nextSshRead])
    if (!save) {
      expect(store.getSnapshot().source!.network!.computers.find(row => row.computer === slow)?.error).toContain("not responding")
      expect(store.getSnapshot().source!.sshAccess!.computers.find(row => row.computer === slow)?.unavailable).toContain("unavailable")
    }
    expect(store.getSnapshot().source!.network!.computers.find(row => row.computer === slow)?.ports[0].hostPort).toBe(save ? 4200 : 3000)
    pendingNetwork.resolve(networkState(slow)); pendingSsh.resolve(sshState(slow))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().source!.network!.computers.find(row => row.computer === slow)?.ports[0].hostPort).toBe(save ? 4200 : 3000)
    expect(store.getSnapshot().source!.sshAccess!.computers.find(row => row.computer === slow)?.enabled).toBe(!save)
  } finally { store.dispose() }
})
