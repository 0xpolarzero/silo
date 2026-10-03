import { afterEach, describe, expect, it } from "vitest"

import { assertNativeBridgeMocksHandled, nativeBridgeMock } from "./native-bridge-mock"

afterEach(assertNativeBridgeMocksHandled)

describe("native bridge mock", () => {
  it("routes an explicit command and preserves its arguments", async () => {
    const invoke = nativeBridgeMock({ read_state: args => ({ id: args?.id }) })
    await expect(invoke("read_state", { id: "computer" })).resolves.toEqual({ id: "computer" })
    expect(invoke).toHaveBeenCalledExactlyOnceWith("read_state", { id: "computer" })
  })

  it("allows an intentional void reply", async () => {
    const invoke = nativeBridgeMock({ cancel: () => undefined })
    await expect(invoke("cancel")).resolves.toBeUndefined()
  })

  it("fails verification even when production code catches an unknown command", async () => {
    const invoke = nativeBridgeMock({ read_state: () => ({}) })
    await expect(invoke("read_stats")).rejects.toThrow("Unhandled native command: read_stats")
    expect(assertNativeBridgeMocksHandled).toThrow("Unhandled native command: read_stats")
  })

  it("rejects object prototype properties as unknown commands", async () => {
    const invoke = nativeBridgeMock({})
    await expect(invoke("toString")).rejects.toThrow("Unhandled native command: toString")
    expect(assertNativeBridgeMocksHandled).toThrow("Unhandled native command: toString")
  })

  it("preserves a scripted failure without treating it as an omission", async () => {
    const invoke = nativeBridgeMock({ read_state: () => { throw new Error("Runtime unavailable") } })
    await expect(invoke("read_state")).rejects.toThrow("Runtime unavailable")
    expect(assertNativeBridgeMocksHandled).not.toThrow()
  })
})
