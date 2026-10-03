import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import { showActionFailure, showOperationFailure } from "@/lib/operation-toast"
import { useNetworkPorts } from "./network-ports-state"

vi.mock("@/lib/operation-toast", () => ({
  errorMessage: (cause: Error) => cause.message,
  showActionFailure: vi.fn(),
  showOperationFailure: vi.fn(),
  showOperationProgress: vi.fn(),
  showOperationSuccess: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

describe("network port retry identity", () => {
  it.each(["replacement", "rename", "unmount"])("does not replay a failed mutation after %s", async (change) => {
    const computer = structuredClone(applicationSourceForScenario("running").computers[0])
    const actions = createApplicationActionsMock()
    const operation = vi.fn().mockRejectedValueOnce(new Error("Could not reach computer")).mockResolvedValue(undefined)
    const view = renderHook(({ computers }) => useNetworkPorts({ computers, actions, active: false }), { initialProps: { computers: [computer] } })
    await act(async () => {
      await view.result.current.run("port-fixture", { computerId: computer.configuration.id, displayName: computer.configuration.name }, { loading: "Removing port", success: "Port removed", failure: "Could not remove port" }, operation)
    })
    const retry = vi.mocked(showOperationFailure).mock.calls[0][2]?.retry
    expect(retry).toBeTypeOf("function")
    if (change === "unmount") view.unmount()
    else view.rerender({ computers: [{ ...computer, configuration: { ...computer.configuration, ...(change === "replacement" ? { id: "replacement-id" } : { name: "renamed" }) } }] })
    await act(async () => retry?.())
    expect(operation).toHaveBeenCalledOnce()
    expect(vi.mocked(showOperationFailure).mock.calls.at(-1)?.[2]?.retry).toBeUndefined()
  })

  it("retries a failed mutation while its computer identity is unchanged", async () => {
    const computer = structuredClone(applicationSourceForScenario("running").computers[0])
    const actions = createApplicationActionsMock()
    const operation = vi.fn().mockRejectedValueOnce(new Error("Temporarily unavailable")).mockResolvedValue(undefined)
    const view = renderHook(() => useNetworkPorts({ computers: [computer], actions, active: false }))
    await act(async () => { await view.result.current.run("port-fixture", { computerId: computer.configuration.id, displayName: computer.configuration.name }, { loading: "Removing port", success: "Port removed", failure: "Could not remove port" }, operation) })
    const retry = vi.mocked(showOperationFailure).mock.calls[0][2]?.retry
    await act(async () => retry?.())
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it("does not open a replacement computer's website through a failure retry", async () => {
    const computer = structuredClone(applicationSourceForScenario("running").computers[0])
    const actions = createApplicationActionsMock({ openNetworkPort: vi.fn().mockRejectedValueOnce(new Error("Browser unavailable")).mockResolvedValue(undefined) })
    const view = renderHook(({ computers }) => useNetworkPorts({ computers, actions, active: false }), { initialProps: { computers: [computer] } })
    await act(async () => { await view.result.current.open(computer, 3000) })
    const retry = vi.mocked(showActionFailure).mock.calls[0][2]
    view.rerender({ computers: [{ ...computer, configuration: { ...computer.configuration, id: "replacement-id" } }] })
    await act(async () => retry?.())
    expect(actions.openNetworkPort).toHaveBeenCalledOnce()
    expect(vi.mocked(showActionFailure).mock.calls.at(-1)?.[2]).toBeUndefined()
  })
})
