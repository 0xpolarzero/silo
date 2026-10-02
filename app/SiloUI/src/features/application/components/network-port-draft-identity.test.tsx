import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import type { ApplicationWorkspace, NetworkState } from "../model/application-source"
import { NetworkPage } from "../pages/network-page"

describe("network port draft sandbox identity", () => {
  it.each(["add", "edit"])("does not %s a port on a replacement sandbox from an old draft", async (operation) => {
    const workspace = structuredClone(applicationSourceForScenario("running").workspaces[0])
    const save = vi.fn().mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ saveNetworkPort: save })
    const network: NetworkState = { workspaces: [{ workspace: workspace.machine.name, error: null, ports: [{ port: 3000, hostPort: 43000, scheme: "http", state: "reachable", configured: true }] }] }
    const page = (workspaces: ApplicationWorkspace[]) => <NetworkPage workspaces={workspaces} network={network} browser="Firefox" actions={actions} active={false} />
    const { rerender } = render(page([workspace]))
    if (operation === "add") {
      fireEvent.click(screen.getByRole("button", { name: "Add port" }))
      fireEvent.change(screen.getByRole("spinbutton", { name: "Port" }), { target: { value: "9000" } })
    } else {
      fireEvent.click(screen.getByRole("button", { name: `Edit port 3000 from ${workspace.machine.name}` }))
      fireEvent.change(screen.getByRole("spinbutton", { name: "Local port" }), { target: { value: "44000" } })
    }
    rerender(page([{ ...workspace, machine: { ...workspace.machine, id: "replacement-id" } }]))
    await act(async () => fireEvent.submit(screen.getByRole("row", { name: operation === "add" ? "New port" : "Edit port" })))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("This sandbox changed")
  })

  it("allows explicitly selecting a different sandbox for a new port", async () => {
    const source = structuredClone(applicationSourceForScenario("running"))
    const workspaces = source.workspaces.filter(workspace => workspace.machine.kind === "vm" && !workspace.computer).map(workspace => ({ ...workspace, state: "running" as const }))
    const save = vi.fn().mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ saveNetworkPort: save })
    render(<NetworkPage workspaces={workspaces} network={{ workspaces: [] }} browser="Firefox" actions={actions} active={false} />)
    fireEvent.click(screen.getByRole("button", { name: "Add port" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Port" }), { target: { value: "9000" } })
    fireEvent.change(screen.getByRole("combobox", { name: "Sandbox" }), { target: { value: workspaces[1].machine.name } })
    await act(async () => fireEvent.submit(screen.getByRole("row", { name: "New port" })))
    expect(save).toHaveBeenCalledExactlyOnceWith({ workspace: workspaces[1].machine.name, port: 9000, hostPort: null, scheme: "http" })
  })
})
