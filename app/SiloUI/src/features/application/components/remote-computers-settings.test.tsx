import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { RemoteComputersSettings } from "./remote-computers-settings"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteManagementSchema } from "../model/remote-computers"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"

function source(remoteManagement: ApplicationSource["remoteManagement"]): ApplicationSource {
  return { ...applicationSourceForScenario("running"), remoteManagement, remoteComputers: [] }
}
function actions(overrides: Partial<ApplicationActions> = {}): ApplicationActions {
  return { connectComputer: vi.fn(), setRemoteManagement: vi.fn(), ...overrides } as unknown as ApplicationActions
}

describe("RemoteComputersSettings", () => {
  it("explains why remote management does not work on this computer", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "Office Mac", address: "owner@office", error: "Another Silo instance owns remote management." })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Another Silo instance owns remote management.")
    expect(screen.getByRole("switch", { name: "Allow remote management" })).toBeEnabled()
  })

  it("offers every address another computer may reach this one at", async () => {
    const status = remoteManagementSchema.parse({
      enabled: true, hostId: "office", name: "studio", address: "ana@studio.local",
      addresses: [
        { address: "ana@studio.local", kind: "name" },
        { address: "ana@100.101.102.103", kind: "tailscale" },
        { address: "ana@192.168.1.4", kind: "network" },
      ],
    })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    const list = screen.getByRole("list", { name: "Addresses for other computers" })
    expect(within(list).getAllByRole("listitem").map(item => item.textContent)).toEqual([
      expect.stringContaining("ana@studio.local"),
      expect.stringContaining("Tailscale"),
      expect.stringContaining("Local network"),
    ])
    fireEvent.click(within(list).getByRole("button", { name: "Copy ana@100.101.102.103" }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("ana@100.101.102.103"))
  })

  it("falls back to the single address from an older status", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "studio", address: "ana@studio" })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    expect(screen.getByRole("button", { name: "Copy ana@studio" })).toBeInTheDocument()
  })

  it("shows no problem when remote management works", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "Office Mac", address: "owner@office", error: null })
    render(<RemoteComputersSettings source={source(status)} actions={actions()} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
