import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { DisclosureHeader } from "./disclosure-header"
import { Collapsible, CollapsibleContent } from "./ui/collapsible"

describe("shared disclosure header", () => {
  it("reveals complete text titles and captions when they are truncated", () => {
    const title = "Remote computer name ".repeat(15)
    const detail = "Connection details ".repeat(20)
    render(<Collapsible><DisclosureHeader title={title} detail={detail} /></Collapsible>)
    expect(screen.getByText(title.trim())).toHaveAttribute("title", title)
    expect(screen.getByText(detail.trim())).toHaveAttribute("title", detail)
  })

  it("toggles from its title, caption, caret and keyboard without triggering sibling actions", async () => {
    const user = userEvent.setup()
    const copy = vi.fn()
    render(<Collapsible>
      <DisclosureHeader title="Example" detail="More information" label="Toggle example" actions={<button onClick={copy}>Copy</button>} />
      <CollapsibleContent>Expanded content</CollapsibleContent>
    </Collapsible>)
    const trigger = screen.getByRole("button", { name: "Toggle example" })
    await user.click(screen.getByText("More information"))
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    await user.click(screen.getByRole("button", { name: "Copy" }))
    expect(copy).toHaveBeenCalledOnce()
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    await user.click(trigger.querySelector("svg")!)
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.click(screen.getByText("Example"))
    expect(screen.getByText("Expanded content")).toBeVisible()
    await user.keyboard(" ")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.keyboard("{Enter}")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(trigger.querySelector("button")).toBeNull()
  })
})
