import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import styles from "@/index.css?raw"
import { ActionsMenu } from "@/components/actions-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TooltipProvider } from "@/components/ui/tooltip"

function Surface({ reduceMotion }: { reduceMotion?: boolean }) {
  return <TooltipProvider reduceMotion={reduceMotion}>
    <section className="silo-window" data-reduce-motion={reduceMotion || undefined}>
      <Popover defaultOpen><PopoverTrigger>Open popover</PopoverTrigger><PopoverContent aria-label="Popover">Body</PopoverContent></Popover>
      <Select defaultValue="one"><SelectTrigger aria-label="Choice"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="one">One</SelectItem><SelectItem value="two">Two</SelectItem></SelectContent>
      </Select>
      <ActionsMenu label="More actions" items={[{ label: "Rename", onSelect: () => {} }]} />
    </section>
  </TooltipProvider>
}

describe("reduced motion in portalled surfaces", () => {
  it("carries the app preference to popovers, selects and menus rendered outside the window", async () => {
    render(<Surface reduceMotion />)
    const user = userEvent.setup()
    const popover = document.querySelector<HTMLElement>("[data-slot='popover-content']")!
    expect(popover.closest(".silo-window")).toBeNull()
    expect(popover).toHaveClass("silo-portal")
    expect(popover).toHaveAttribute("data-reduce-motion", "true")

    await user.click(screen.getByRole("combobox", { name: "Choice" }))
    const select = document.querySelector<HTMLElement>("[data-slot='select-content']")!
    expect(select.closest(".silo-window")).toBeNull()
    expect(select).toHaveClass("silo-portal")
    expect(select).toHaveAttribute("data-reduce-motion", "true")
    await user.keyboard("{Escape}")

    await user.click(screen.getByRole("button", { name: "More actions" }))
    const menu = screen.getByRole("menu")
    expect(menu.closest(".silo-window")).toBeNull()
    expect(menu).toHaveClass("silo-portal")
    expect(menu).toHaveAttribute("data-reduce-motion", "true")
  })

  it("leaves portalled motion to the system setting when the app preference is off", () => {
    render(<Surface />)
    const popover = document.querySelector<HTMLElement>("[data-slot='popover-content']")!
    expect(popover).toHaveClass("silo-portal")
    expect(popover).not.toHaveAttribute("data-reduce-motion")
  })

  it("disables portalled animations for the app preference and the system setting", () => {
    // jsdom does not apply stylesheets; check the rules that honour the marker instead.
    const css = styles.replace(/\s+/g, " ")
    expect(css).toMatch(/\.silo-portal\[data-reduce-motion="true"\], \.silo-portal\[data-reduce-motion="true"\] \* \{[^}]*animation: none !important;[^}]*\}/)
    const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(media).toMatch(/\.silo-portal, \.silo-portal \* \{[^}]*transition-duration: 0s !important;[^}]*animation: none !important;/)
  })
})
