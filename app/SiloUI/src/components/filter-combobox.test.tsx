import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { FilterCombobox } from "./filter-combobox"

const options = Array.from({ length: 30 }, (_, index) => ({ value: `sandbox-${index}`, label: `Sandbox ${index}` }))

function Filter({ available = options }: { available?: typeof options }) {
  const [selectedValues, onChange] = useState(new Set<string>())
  return <FilterCombobox
    options={available} selectedValues={selectedValues} onChange={onChange}
    label="Sandbox filters" inputLabel="Add sandbox" placeholder="Choose a sandbox"
    listLabel="Available sandboxes" selectedLabel="Selected sandboxes" emptyMessage="No matches"
  />
}

describe("FilterCombobox keyboard navigation", () => {
  it("leaves the filter on Tab without entering its popup options", async () => {
    const user = userEvent.setup()
    render(<Filter />)
    await user.click(screen.getByRole("combobox"))
    await user.tab()
    expect(document.body).toHaveFocus()
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("reveals the active option in both directions while keeping focus in the input", async () => {
    const user = userEvent.setup()
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
    render(<Filter />)
    const input = screen.getByRole("combobox", { name: "Add sandbox" })
    await user.click(input)
    await user.keyboard("{ArrowDown>20/}")
    const active = screen.getByRole("option", { name: "Sandbox 20", selected: true })
    expect(input).toHaveAttribute("aria-activedescendant", active.id)
    expect(input).toHaveFocus()
    expect(scroll.mock.contexts.at(-1)).toBe(active)
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" })

    await user.keyboard("{ArrowUp>15/}")
    const previous = screen.getByRole("option", { name: "Sandbox 5", selected: true })
    expect(scroll.mock.contexts.at(-1)).toBe(previous)
    expect(input).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("button", { name: "Remove Sandbox 5" })).toBeInTheDocument()
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    expect(input).toHaveFocus()
  })

  it("reveals the first matching option when the search results change", async () => {
    const user = userEvent.setup()
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
    render(<Filter />)
    await user.click(screen.getByRole("combobox"))
    await user.keyboard("{ArrowDown>20/}")
    await user.type(screen.getByRole("combobox"), "Sandbox 29")
    const match = screen.getByRole("option", { name: "Sandbox 29", selected: true })
    expect(scroll.mock.contexts.at(-1)).toBe(match)
  })

  it("keeps a valid active option when the available sandbox list shrinks", async () => {
    const user = userEvent.setup()
    const view = render(<Filter />)
    const input = screen.getByRole("combobox")
    await user.click(input)
    await user.keyboard("{ArrowDown>20/}")
    view.rerender(<Filter available={options.slice(0, 3)} />)
    const active = screen.getByRole("option", { name: "Sandbox 2", selected: true })
    expect(input).toHaveAttribute("aria-activedescendant", active.id)
    await user.keyboard("{Enter}")
    expect(screen.getByRole("button", { name: "Remove Sandbox 2" })).toBeInTheDocument()
  })
})
