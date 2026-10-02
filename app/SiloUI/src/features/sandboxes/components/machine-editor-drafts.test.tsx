import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { ComponentProps } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineEditorDraftsProvider } from "@/features/sandboxes/model/editor-drafts"
import { MachineList } from "./machine-list"

type MachineListProps = ComponentProps<typeof MachineList>

const machine = productionMachineDefaults[0]!

function Surface({ shown, withProvider = true, onMachinesChange, onCommitMachine, machines = [machine] }: { shown: boolean; withProvider?: boolean; onMachinesChange: () => void; onCommitMachine?: MachineListProps["onCommitMachine"]; machines?: MachineListProps["machines"] }) {
  const list = shown ? <MachineList machines={machines} onMachinesChange={onMachinesChange} onCommitMachine={onCommitMachine} isMachineCreated={() => true}
    isMachineRunning={() => false} editorDraftKey="sandbox-list" getRowPresentation={() => ({ menuActions: [] })} /> : <p>Files</p>
  return <TooltipProvider>{withProvider ? <MachineEditorDraftsProvider>{list}</MachineEditorDraftsProvider> : list}</TooltipProvider>
}

async function editCpuLimit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: `More actions for ${machine.name}` }))
  await user.click(screen.getByRole("menuitem", { name: `Edit ${machine.name}` }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
}

describe("unsaved sandbox edits across navigation", () => {
  it("keeps a restored draft editable after a pending save is rejected", async () => {
    let reject!: (cause: unknown) => void
    const pending = new Promise<void>((_resolve, fail) => { reject = fail })
    const props = { onMachinesChange: vi.fn(), onCommitMachine: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined) }
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown {...props} />)
    await editCpuLimit(user)
    await user.click(screen.getByRole("button", { name: "Save" }))
    rerender(<Surface shown={false} {...props} />)
    rerender(<Surface shown {...props} />)
    await act(async () => reject(new Error("This sandbox changed while your edit was waiting. Review it and try again.")))
    expect(screen.getByRole("alert")).toHaveTextContent("This sandbox changed since you opened it.")
    expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
    expect(screen.getByRole("combobox", { name: "CPUs" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Review changes" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(props.onCommitMachine).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
  })

  it("forgets a saved edit when the save completes after leaving", async () => {
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    const props = { onMachinesChange: vi.fn(), onCommitMachine: vi.fn(() => pending) }
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown {...props} />)
    await editCpuLimit(user)
    await user.click(screen.getByRole("button", { name: "Save" }))
    rerender(<Surface shown={false} {...props} />)
    await act(async () => resolve())
    rerender(<Surface shown machines={[{ ...machine, cpus: 4 }]} {...props} />)
    expect(screen.queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
    expect(props.onCommitMachine).toHaveBeenCalledTimes(1)
  })

  it("keeps a save pending when returning before it completes", async () => {
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    const props = { onMachinesChange: vi.fn(), onCommitMachine: vi.fn(() => pending) }
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown {...props} />)
    await editCpuLimit(user)
    await user.click(screen.getByRole("button", { name: "Save" }))
    rerender(<Surface shown={false} {...props} />)
    rerender(<Surface shown {...props} />)
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "CPUs" })).toBeDisabled()
    await act(async () => resolve())
    expect(screen.queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
    rerender(<Surface shown={false} {...props} />)
    rerender(<Surface shown {...props} />)
    expect(screen.queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
    expect(props.onCommitMachine).toHaveBeenCalledTimes(1)
  })

  it("keeps an edit when the Add menu is opened and dismissed", async () => {
    const onMachinesChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown onMachinesChange={onMachinesChange} />)
    await editCpuLimit(user)
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.keyboard("{Escape}")
    expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
    rerender(<Surface shown={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown onMachinesChange={onMachinesChange} />)
    expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith([{ ...machine, cpus: 4 }], [machine])
  })

  it("restores the open editor and its baseline after leaving and returning", async () => {
    const onMachinesChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown onMachinesChange={onMachinesChange} />)
    await editCpuLimit(user)
    rerender(<Surface shown={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown onMachinesChange={onMachinesChange} />)
    expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("4")
    // The restored edit still saves against the configuration it started from.
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith([{ ...machine, cpus: 4 }], [machine])
    rerender(<Surface shown={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown onMachinesChange={onMachinesChange} />)
    expect(screen.queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
  })

  it("forgets a cancelled edit", async () => {
    const onMachinesChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown onMachinesChange={onMachinesChange} />)
    await editCpuLimit(user)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    rerender(<Surface shown={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown onMachinesChange={onMachinesChange} />)
    expect(screen.queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
  })

  it("keeps nothing outside a provider", async () => {
    const onMachinesChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Surface shown withProvider={false} onMachinesChange={onMachinesChange} />)
    await editCpuLimit(user)
    rerender(<Surface shown={false} withProvider={false} onMachinesChange={onMachinesChange} />)
    rerender(<Surface shown withProvider={false} onMachinesChange={onMachinesChange} />)
    expect(screen.queryByRole("combobox", { name: "CPUs" })).not.toBeInTheDocument()
  })
})
