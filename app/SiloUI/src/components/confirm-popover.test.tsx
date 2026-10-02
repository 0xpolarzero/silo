import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ConfirmPopover, FormPopover } from "@/components/confirm-popover"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"

describe("ConfirmPopover", () => {
  function setup(onConfirm = vi.fn()) {
    render(<ConfirmPopover title="Delete it?" description="Cannot be undone" confirmLabel="Delete" tone="destructive" onConfirm={onConfirm}><button type="button">Trigger</button></ConfirmPopover>)
    return onConfirm
  }

  it("confirms, closes immediately and focuses the confirm button", async () => {
    const onConfirm = setup()
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }))
    expect(screen.getByRole("dialog", { name: "Delete it?" })).toHaveAccessibleDescription("Cannot be undone")
    expect(screen.getByText("Cannot be undone")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus())
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(screen.queryByText("Delete it?")).not.toBeInTheDocument()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
  })

  it("Enter confirms", async () => {
    const onConfirm = setup()
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus())
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
  })

  it("Cancel, Escape and outside click dismiss without confirming", async () => {
    const onConfirm = setup()
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }))
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByText("Delete it?")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }))
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText("Delete it?")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }))
    await userEvent.click(document.body)
    await waitFor(() => expect(screen.queryByText("Delete it?")).not.toBeInTheDocument())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("opens from an external anchor when controlled", () => {
    render(<ConfirmPopover open onOpenChange={() => {}} title="Import?" confirmLabel="Import" onConfirm={() => {}} anchor={<button type="button">Add</button>} />)
    expect(screen.getByText("Import?")).toBeInTheDocument()
  })

  it("keeps the names and descriptions of separate confirmations distinct", () => {
    render(<>
      <ConfirmPopover open title="Delete alpha?" description="Alpha is removed." confirmLabel="Delete" onConfirm={vi.fn()} />
      <ConfirmPopover open title="Delete beta?" description="Beta is removed." confirmLabel="Delete" onConfirm={vi.fn()} />
    </>)
    const alpha = screen.getByRole("dialog", { name: "Delete alpha?" })
    const beta = screen.getByRole("dialog", { name: "Delete beta?" })
    expect(alpha).toHaveAccessibleDescription("Alpha is removed.")
    expect(beta).toHaveAccessibleDescription("Beta is removed.")
    expect(alpha.getAttribute("aria-labelledby")).not.toBe(beta.getAttribute("aria-labelledby"))
  })
})

describe("FormPopover", () => {
  function Form({ onSubmit }: { onSubmit: (v: string) => void }) {
    return <FormHarness onSubmit={onSubmit} />
  }
  function FormHarness({ onSubmit }: { onSubmit: (v: string) => void }) {
    const [value, setValue] = (require as never as never, useState(""))
    return <FormPopover title="Rename" confirmLabel="Save" canSubmit={value.trim().length > 0} onSubmit={() => onSubmit(value)} fields={<input aria-label="Name" value={value} onChange={(e) => setValue(e.target.value)} />}><button type="button">Open</button></FormPopover>
  }
  it("focuses the first field, gates submit and submits on Enter", async () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    expect(screen.getByRole("dialog", { name: "Rename" })).not.toHaveAttribute("aria-describedby")
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus())
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "abc")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("abc"))
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument()
  })

  it("associates the form description with its dialog", () => {
    render(<FormPopover open title="Rename sandbox" description="Choose a unique name." confirmLabel="Save" onSubmit={vi.fn()} fields={<input aria-label="Name" />} />)
    expect(screen.getByRole("dialog", { name: "Rename sandbox" })).toHaveAccessibleDescription("Choose a unique name.")
  })
})

describe("popovers with a trigger tooltip", () => {
  it("closes on one Escape after hover then click, with focus in the popover and back on the trigger", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(<TooltipProvider>
      <ConfirmPopover tone="destructive" title="Remove thing?" description="It goes away." confirmLabel="Remove" tooltip="Remove thing" onConfirm={onConfirm}>
        <Button aria-label="Remove thing">x</Button>
      </ConfirmPopover>
    </TooltipProvider>)
    const trigger = screen.getByRole("button", { name: "Remove thing" })
    await user.hover(trigger)
    expect(await screen.findByRole("tooltip")).toBeVisible()
    await user.click(trigger)
    expect(screen.getByText("Remove thing?")).toBeVisible()
    expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus()
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText("Remove thing?")).not.toBeInTheDocument())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  it("keeps the tooltip closed over its own open popover", async () => {
    const user = userEvent.setup()
    render(<TooltipProvider>
      <ConfirmPopover title="Remove thing?" confirmLabel="Remove" tooltip="Remove thing" onConfirm={vi.fn()}>
        <Button aria-label="Remove thing">x</Button>
      </ConfirmPopover>
    </TooltipProvider>)
    const trigger = screen.getByRole("button", { name: "Remove thing" })
    await user.click(trigger)
    await user.unhover(trigger)
    await user.hover(trigger)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  it("focuses the first field of a form popover and closes it on one Escape", async () => {
    const user = userEvent.setup()
    render(<TooltipProvider>
      <FormPopover title="Rename" confirmLabel="Save" tooltip="Rename it" onSubmit={vi.fn()} fields={<input aria-label="Name" />}>
        <Button aria-label="Rename thing">x</Button>
      </FormPopover>
    </TooltipProvider>)
    const trigger = screen.getByRole("button", { name: "Rename thing" })
    await user.hover(trigger)
    await user.click(trigger)
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})
