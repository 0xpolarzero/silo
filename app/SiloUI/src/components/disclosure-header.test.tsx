import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { DisclosureHeader } from "./disclosure-header"
import { Collapsible, CollapsibleContent } from "./ui/collapsible"

describe("shared disclosure header", () => {
  it("describes explicitly labelled disclosures with their own current caption", () => {
    const headers = (detail: string) => <>
      <Collapsible><DisclosureHeader title="Requirements" label="Requirements" detail={detail} /></Collapsible>
      <Collapsible><DisclosureHeader title="Runtime" label="Runtime" detail="Checking 2 requirements…" /></Collapsible>
    </>
    const view = render(headers("2 checks failed"))
    expect(screen.getByRole("button", { name: "Requirements" })).toHaveAccessibleDescription("2 checks failed")
    expect(screen.getByRole("button", { name: "Runtime" })).toHaveAccessibleDescription("Checking 2 requirements…")
    view.rerender(headers("4 of 4 checks passed"))
    expect(screen.getByRole("button", { name: "Requirements" })).toHaveAccessibleDescription("4 of 4 checks passed")
  })

  it("keeps captions in the natural button name when there is no explicit label", () => {
    render(<Collapsible><DisclosureHeader title="Requirements" detail="2 checks failed" /></Collapsible>)
    expect(screen.getByRole("button", { name: /Requirements\s*2 checks failed/ })).toHaveAccessibleDescription("")
  })

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
