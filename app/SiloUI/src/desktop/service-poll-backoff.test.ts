import { afterEach, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { assertNativeBridgeMocksHandled, nativeBridgeMock } from "@/test/native-bridge-mock"
import { createProductionSource, type ProductionBridge } from "./production-source"

afterEach(() => { assertNativeBridgeMocksHandled(); vi.useRealTimers(); vi.restoreAllMocks() })

it.each(["network", "ssh"] as const)("backs off failed %s owners without delaying healthy owners or explicit refresh", async service => {
  vi.useFakeTimers()
  const local = applicationSourceForScenario("running")
  const command = service === "network" ? "remote_network_state" : "remote_ssh_access_state"
  let failing = false
  const remote = (args?: Record<string, unknown>) => {
    if (failing && args?.deviceId === "broken") throw new Error("Unavailable")
    return { computers: [] }
  }
  const invoke = nativeBridgeMock({
    read_application_state: () => local,
    read_backup_state: () => ({ snapshotId: "fixture", availability: "available", archives: [], operation: null }),
    read_operation_queue: () => ({ running: [], waiting: [] }),
    read_setup_activity: () => [],
    device_list: () => ["broken", "healthy"].map(id => ({ id, name: id, address: `user@${id}` })),
    device_snapshot: () => local,
    connections_status: () => ({ enabled: false, deviceId: "local", name: "Laptop", address: "user@laptop" }),
    read_network_state: () => ({ computers: [] }),
    read_ssh_access_state: () => ({ computers: [] }),
    remote_network_state: remote,
    remote_ssh_access_state: remote,
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  const refresh = store.applicationActions[service === "network" ? "refreshNetwork" : "refreshSshAccess"] as (options?: { background?: boolean }) => Promise<void>
  const reads = (id: string) => invoke.mock.calls.filter(([name, args]) => name === command && args?.deviceId === id).length
  try {
    await store.initialize()
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    failing = true
    await refresh({ background: true })
    let calls = reads("broken")
    for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
      const healthy = reads("healthy")
      await vi.advanceTimersByTimeAsync(delay - 1)
      await refresh({ background: true })
      expect(reads("broken")).toBe(calls)
      expect(reads("healthy")).toBe(healthy + 1)
      await vi.advanceTimersByTimeAsync(1)
      await refresh({ background: true })
      expect(reads("broken")).toBe(++calls)
    }
    failing = false
    await refresh()
    expect(reads("broken")).toBe(++calls)
    await vi.advanceTimersByTimeAsync(5000)
    await refresh({ background: true })
    expect(reads("broken")).toBe(++calls)
  } finally { store.dispose() }
})

it.each(["network", "ssh"] as const)("does not queue an immediate %s retry from a background tick during a pending read", async service => {
  vi.useFakeTimers()
  const local = applicationSourceForScenario("running")
  const command = service === "network" ? "read_network_state" : "read_ssh_access_state"
  let reject!: (cause: Error) => void
  const pending = new Promise<unknown>((_, fail) => { reject = fail })
  let hold = false
  const invoke = nativeBridgeMock({
    read_application_state: () => local,
    read_backup_state: () => ({ snapshotId: "fixture", availability: "available", archives: [], operation: null }),
    read_operation_queue: () => ({ running: [], waiting: [] }),
    read_setup_activity: () => [],
    device_list: () => [],
    connections_status: () => ({ enabled: false, deviceId: "local", name: "Laptop", address: "user@laptop" }),
    read_network_state: () => hold && service === "network" ? pending : { computers: [] },
    read_ssh_access_state: () => hold && service === "ssh" ? pending : { computers: [] },
  })
  const store = createProductionSource({ invoke, listen: async () => () => {} } as ProductionBridge)
  const refresh = store.applicationActions[service === "network" ? "refreshNetwork" : "refreshSshAccess"]!
  try {
    await store.initialize()
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    const initial = invoke.mock.calls.filter(([name]) => name === command).length
    hold = true
    const first = refresh({ background: true })
    const overlapping = refresh({ background: true })
    reject(new Error("Unavailable"))
    await Promise.all([first, overlapping])
    expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(initial + 1)
    await vi.advanceTimersByTimeAsync(9999)
    await refresh({ background: true })
    expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(initial + 1)
  } finally { store.dispose() }
})
