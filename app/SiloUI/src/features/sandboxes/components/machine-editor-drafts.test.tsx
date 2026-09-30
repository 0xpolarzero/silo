import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineEditorDraftsProvider } from "@/features/sandboxes/model/editor-drafts"
import { MachineList } from "./machine-list"

const machine = productionMachineDefaults[0]!

function Surface({ shown, withProvider = true, onMachinesChange }: { shown: boolean; withProvider?: boolean; onMachinesChange: () => void }) {
  const list = shown ? <MachineList machines={[machine]} onMachinesChange={onMachinesChange} isMachineCreated={() => true}
    isMachineRunning={() => false} editorDraftKey="sandbox-list" getRowPresentation={() => ({ menuActions: [] })} /> : <p>Files</p>
  return <TooltipProvider>{withProvider ? <MachineEditorDraftsProvider>{list}</MachineEditorDraftsProvider> : list}</TooltipProvider>
}

async function editCpuLimit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${machine.name}` }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPU limit" }), "4")
}

describe("unsaved sandbox edits across navigation", () => {
  it("restores the open editor and its baseline after leaving and returning", async () => {
    const onMachinesChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown onMachinesChange={onMachinesChange} />)
    await editCpuLimit(user)
    rerender(<Surface shown={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown onMachinesChange={onMachinesChange} />)
    expect(screen.getByRole("combobox", { name: "CPU limit" })).toHaveValue("4")
    // The restored edit still saves against the configuration it started from.
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith([{ ...machine, cpus: 4 }], [machine])
    rerender(<Surface shown={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown onMachinesChange={onMachinesChange} />)
    expect(screen.queryByRole("combobox", { name: "CPU limit" })).not.toBeInTheDocument()
  })

  it("forgets a cancelled edit", async () => {
    const onMachinesChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown onMachinesChange={onMachinesChange} />)
    await editCpuLimit(user)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    rerender(<Surface shown={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown onMachinesChange={onMachinesChange} />)
    expect(screen.queryByRole("combobox", { name: "CPU limit" })).not.toBeInTheDocument()
  })

  it("keeps nothing outside a provider", async () => {
    const onMachinesChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown withProvider={false} onMachinesChange={onMachinesChange} />)
    await editCpuLimit(user)
    rerender(<Surface shown={false} withProvider={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown withProvider={false} onMachinesChange={onMachinesChange} />)
    expect(screen.queryByRole("combobox", { name: "CPU limit" })).not.toBeInTheDocument()
  })
})
