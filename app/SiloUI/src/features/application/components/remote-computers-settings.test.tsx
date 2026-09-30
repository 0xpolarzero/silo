import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { RemoteComputersSettings } from "./remote-computers-settings"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { remoteManagementSchema } from "../model/remote-computers"
import type { ApplicationSource } from "../model/application-source"

function source(remoteManagement: ApplicationSource["remoteManagement"]): ApplicationSource {
  return { ...applicationSourceForScenario("running"), remoteManagement, remoteComputers: [] }
}

describe("RemoteComputersSettings", () => {
  it("explains why remote management does not work on this computer", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "Office Mac", address: "owner@office", error: "Another Silo instance owns remote management." })
    render(<RemoteComputersSettings source={source(status)} actions={{ connectComputer: vi.fn(), setRemoteManagement: vi.fn() }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Another Silo instance owns remote management.")
    expect(screen.getByRole("switch", { name: "Allow remote management" })).toBeEnabled()
  })

  it("shows no problem when remote management works", () => {
    const status = remoteManagementSchema.parse({ enabled: true, hostId: "office", name: "Office Mac", address: "owner@office", error: null })
    render(<RemoteComputersSettings source={source(status)} actions={{ connectComputer: vi.fn(), setRemoteManagement: vi.fn() }} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
