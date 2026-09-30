import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { withResourceFixture } from "@/fixtures/application-resources"

describe("operation-owned resource notices", () => {
  it("shows no resource dashboard in the quiet state", () => {
    render(<ApplicationPreview source={applicationSourceForScenario("running")} />)
    expect(screen.queryByText(/memory pressure/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/available.*GB/i)).not.toBeInTheDocument()
  })

  it("advises for the selected VM and keeps Start anyway", async () => {
    const startWorkspace = vi.fn()
    render(<ApplicationPreview source={withResourceFixture(applicationSourceForScenario("running", undefined, "stopped"), "start-memory")} actions={{ startWorkspace }} />)
    fireEvent.click(screen.getByRole("button", { name: "Start playgrounds" }))
    expect(screen.queryByText(/memory pressure/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Start dev" }))
    // The question opens next to the Start button that asked it.
    const prompt = screen.getByText("Starting dev may slow this computer").closest<HTMLElement>("[data-slot=popover-content]")!
    expect(prompt).toHaveTextContent("32 GB")
    expect(startWorkspace).not.toHaveBeenCalledWith("dev")
    fireEvent.click(within(prompt).getByRole("button", { name: "Start anyway" }))
    await waitFor(() => expect(startWorkspace).toHaveBeenCalledWith("dev"))
  })

  it("blocks Create only after the user saves the affected VM", async () => {
    render(<><Toaster /><ApplicationPreview source={withResourceFixture(applicationSourceForScenario("running"), "create-storage")} /></>)
    expect(screen.queryByText(/Not enough storage/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "New sandbox" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Machine name" }), { target: { value: "sandbox" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect((await screen.findAllByText(/Not enough storage to create sandbox.*18 GB is needed.*11 GB is available/)).length).toBeGreaterThan(0)
  })

  it("reports unavailable native VM actions without changing fixture state", async () => {
    const startWorkspace = vi.fn()
    render(<><Toaster /><ApplicationPreview source={applicationSourceForScenario("running", undefined, "stopped")} nativeOperations actions={{ startWorkspace }} /></>)

    fireEvent.click(screen.getByRole("button", { name: "Start dev" }))

    expect(await screen.findByText("VM operation unavailable")).toBeVisible()
    expect(startWorkspace).not.toHaveBeenCalled()
  })
})
