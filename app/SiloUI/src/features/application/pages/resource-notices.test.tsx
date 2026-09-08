import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { withResourceFixture } from "@/fixtures/application-resources"

describe("operation-owned resource notices", () => {
  it("shows no resource dashboard in the quiet state", () => {
    render(<ApplicationPreview source={applicationSourceForScenario("running")} />)
    expect(screen.queryByText(/memory pressure/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/available.*GB/i)).not.toBeInTheDocument()
  })

  it("advises for the selected VM and keeps Start anyway", () => {
    const startWorkspace = vi.fn()
    render(<ApplicationPreview source={withResourceFixture(applicationSourceForScenario("running", undefined, "stopped"), "start-memory")} actions={{ startWorkspace }} />)
    fireEvent.click(screen.getByRole("button", { name: "Start playgrounds" }))
    expect(screen.queryByText(/memory pressure/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Start dev" }))
    expect(screen.getByRole("status")).toHaveTextContent("dev")
    expect(screen.getByRole("status")).toHaveTextContent("32 GB")
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }))
    expect(startWorkspace).toHaveBeenCalledWith("dev")
  })

  it("blocks Create only after the user saves the affected VM", () => {
    render(<ApplicationPreview source={withResourceFixture(applicationSourceForScenario("running"), "create-storage")} />)
    expect(screen.queryByText(/Not enough storage/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "New sandbox" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Machine name" }), { target: { value: "sandbox" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(screen.getByRole("alert")).toHaveTextContent("Not enough storage to create sandbox")
    expect(screen.getByRole("alert")).toHaveTextContent("18 GB is needed")
    expect(screen.getByRole("alert")).toHaveTextContent("11 GB is available")
  })

  it("reports unavailable native VM actions without changing fixture state", () => {
    const startWorkspace = vi.fn()
    render(<ApplicationPreview source={applicationSourceForScenario("running", undefined, "stopped")} nativeOperations actions={{ startWorkspace }} />)

    fireEvent.click(screen.getByRole("button", { name: "Start dev" }))

    expect(screen.getByRole("alert")).toHaveTextContent("VM operation unavailable")
    expect(startWorkspace).not.toHaveBeenCalled()
  })
})
