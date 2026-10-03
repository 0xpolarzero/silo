import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ComputerListRow } from "@/features/computers/components/computer-list"

describe("openable list rows", () => {
  it("reveals complete text details when they are truncated", () => {
    const detail = "Computer connection details ".repeat(20)
    render(<ComputerListRow name="dev" detail={detail} />)
    expect(screen.getByText(detail.trim())).toHaveAttribute("title", detail)
  })

  it("keeps controls in the row detail independent of opening the row", async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const cancel = vi.fn()
    render(<ComputerListRow name="dev" onOpen={onOpen} detail={<span>Starting · <button type="button" onClick={cancel}>Cancel</button></span>} />)

    const open = screen.getByRole("button", { name: "Open dev" })
    expect(open).not.toHaveTextContent("Starting")
    expect(open).not.toContainElement(screen.getByRole("button", { name: "Cancel" }))

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()

    screen.getByRole("button", { name: "Cancel" }).focus()
    await user.keyboard("{Enter}")
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(onOpen).not.toHaveBeenCalled()

    await user.click(screen.getByText("Starting ·", { exact: false }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    await user.click(open)
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
