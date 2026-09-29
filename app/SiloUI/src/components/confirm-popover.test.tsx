import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ConfirmPopover, FormPopover } from "@/components/confirm-popover"

describe("ConfirmPopover", () => {
  function setup(onConfirm = vi.fn()) {
    render(<ConfirmPopover title="Delete it?" description="Cannot be undone" confirmLabel="Delete" tone="destructive" onConfirm={onConfirm}><button type="button">Trigger</button></ConfirmPopover>)
    return onConfirm
  }

  it("confirms, closes immediately and focuses the confirm button", async () => {
    const onConfirm = setup()
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }))
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
})
