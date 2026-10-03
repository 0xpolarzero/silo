import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import { showOperationFailure } from "@/lib/operation-toast"
import { NetworkPage } from "../pages/network-page"

vi.mock("@/lib/operation-toast", () => ({
  errorMessage: (cause: Error) => cause.message,
  showActionFailure: vi.fn(),
  showOperationFailure: vi.fn(),
  showOperationProgress: vi.fn(),
  showOperationSuccess: vi.fn(),
}))
beforeEach(() => vi.clearAllMocks())

describe("port Retry preserves subsequent drafts", () => {
  it.each(["edited", "new"])("does not discard the %s draft after an older save succeeds", async (draftKind) => {
    const computers = [structuredClone(applicationSourceForScenario("running").computers[0])]
    const save = vi.fn().mockRejectedValueOnce(new Error("Local port occupied")).mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ saveNetworkPort: save })
    render(<NetworkPage computers={computers} network={{ computers: [] }} browser="Firefox" actions={actions} active={false} />)
    fireEvent.click(screen.getByRole("button", { name: "Add port" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Port" }), { target: { value: "9000" } })
    await act(async () => fireEvent.submit(screen.getByRole("row", { name: "New port" })))
    const retry = vi.mocked(showOperationFailure).mock.calls[0][2]?.retry
    expect(retry).toBeTypeOf("function")
    if (draftKind === "new") {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
      fireEvent.click(screen.getByRole("button", { name: "Add port" }))
    }
    fireEvent.change(screen.getByRole("spinbutton", { name: "Port" }), { target: { value: "9001" } })
    await act(async () => retry?.())
    expect(save).toHaveBeenNthCalledWith(2, { computer: computers[0].configuration.name, port: 9000, hostPort: null, scheme: "http" })
    expect(screen.getByRole("spinbutton", { name: "Port" })).toHaveValue(9001)
  })
})
