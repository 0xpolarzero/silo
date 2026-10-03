import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("advises for the selected computer and keeps Start anyway", async () => {
    const startComputer = vi.fn()
    render(<ApplicationPreview source={withResourceFixture(applicationSourceForScenario("running", undefined, "stopped"), "start-memory")} actions={{ startComputer }} />)
    fireEvent.click(screen.getByRole("button", { name: "Start playgrounds" }))
    expect(screen.queryByText(/memory pressure/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Start dev" }))
    // The question opens next to the Start button that asked it.
    const prompt = screen.getByText("Starting dev may slow this device").closest<HTMLElement>("[data-slot=popover-content]")!
    expect(prompt).toHaveTextContent("32 GiB")
    expect(startComputer).not.toHaveBeenCalledWith("dev")
    fireEvent.click(within(prompt).getByRole("button", { name: "Start anyway" }))
    await waitFor(() => expect(startComputer).toHaveBeenCalledWith("dev"))
  })

  it("blocks Create only after the user saves the affected computer", async () => {
    const user = userEvent.setup()
    render(<><Toaster /><ApplicationPreview source={withResourceFixture(applicationSourceForScenario("running"), "create-storage")} /></>)
    expect(screen.queryByText(/Not enough storage/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(screen.getByRole("menuitem", { name: "New computer" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Computer name" }), { target: { value: "computer" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    expect((await screen.findAllByText(/Not enough storage to create computer.*18 GiB is needed.*11 GiB is available/)).length).toBeGreaterThan(0)
  })

  it("reports unavailable native computer actions without changing fixture state", async () => {
    const startComputer = vi.fn()
    render(<><Toaster /><ApplicationPreview source={applicationSourceForScenario("running", undefined, "stopped")} nativeOperations actions={{ startComputer }} /></>)

    fireEvent.click(screen.getByRole("button", { name: "Start dev" }))

    expect(await screen.findByText("Computer operation unavailable")).toBeVisible()
    expect(startComputer).not.toHaveBeenCalled()
  })
})
