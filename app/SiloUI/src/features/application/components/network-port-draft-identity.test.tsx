import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import type { ApplicationComputer, NetworkState } from "../model/application-source"
import { NetworkPage } from "../pages/network-page"

describe("network port draft computer identity", () => {
  it.each(["add", "edit"])("does not %s a port on a replacement computer from an old draft", async (operation) => {
    const computer = structuredClone(applicationSourceForScenario("running").computers[0])
    const save = vi.fn().mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ saveNetworkPort: save })
    const network: NetworkState = { computers: [{ computer: computer.configuration.name, error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", state: "reachable", configured: true }] }] }
    const page = (computers: ApplicationComputer[]) => <NetworkPage computers={computers} network={network} browser="Firefox" actions={actions} active={false} />
    const { rerender } = render(page([computer]))
    if (operation === "add") {
      fireEvent.click(screen.getByRole("button", { name: "Add port" }))
      fireEvent.change(screen.getByRole("spinbutton", { name: "Port" }), { target: { value: "9000" } })
    } else {
      fireEvent.click(screen.getByRole("button", { name: `Edit port 3000 from ${computer.configuration.name}` }))
      fireEvent.change(screen.getByRole("spinbutton", { name: "Local port" }), { target: { value: "44000" } })
    }
    rerender(page([{ ...computer, configuration: { ...computer.configuration, id: "replacement-id" } }]))
    await act(async () => fireEvent.submit(screen.getByRole("row", { name: operation === "add" ? "New port" : "Edit port" })))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("This computer changed")
  })

  it("allows explicitly selecting a different computer for a new port", async () => {
    const source = structuredClone(applicationSourceForScenario("running"))
    const computers = source.computers.filter(computer => !computer.device).map(computer => ({ ...computer, state: "running" as const }))
    const save = vi.fn().mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ saveNetworkPort: save })
    render(<NetworkPage computers={computers} network={{ computers: [] }} browser="Firefox" actions={actions} active={false} />)
    fireEvent.click(screen.getByRole("button", { name: "Add port" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Port" }), { target: { value: "9000" } })
    fireEvent.change(screen.getByRole("combobox", { name: "Computer" }), { target: { value: computers[1].configuration.name } })
    await act(async () => fireEvent.submit(screen.getByRole("row", { name: "New port" })))
    expect(save).toHaveBeenCalledExactlyOnceWith({ computer: computers[1].configuration.name, port: 9000, hostPort: null, scheme: "http" })
  })
})
