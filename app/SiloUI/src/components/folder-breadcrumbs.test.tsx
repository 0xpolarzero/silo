import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { FolderBreadcrumbs } from "./folder-breadcrumbs"

let width = 340
let fullWidth = 600
let resize: () => void
beforeEach(() => {
  width = 340
  fullWidth = 600
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => fullWidth)
  vi.stubGlobal("ResizeObserver", class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe(element: Element) { if (element.tagName === "NAV") resize = this.callback }
    unobserve() {} disconnect() {}
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("collapses middle ancestors and navigates to their exact path", async () => {
  const navigate = vi.fn()
  render(<FolderBreadcrumbs segments={["projects", "client", "src"]} onNavigate={navigate} />)
  const nav = within(screen.getByRole("navigation", { name: "Folder path" }))
  expect(nav.getByRole("button", { name: "/workspace" })).toBeVisible()
  expect(nav.getByRole("button", { name: "src" })).toHaveAttribute("aria-current", "location")
  expect(nav.queryByRole("button", { name: "projects" })).not.toBeInTheDocument()
  await userEvent.click(nav.getByRole("button", { name: "Show parent folders" }))
  await userEvent.click(screen.getByRole("menuitem", { name: "client" }))
  expect(navigate).toHaveBeenCalledWith(["projects", "client"])
})

it("moves the root into the menu on narrow panels and restores the full path when it fits", async () => {
  width = 120
  const navigate = vi.fn()
  render(<FolderBreadcrumbs segments={["projects", "src"]} onNavigate={navigate} />)
  expect(screen.queryByRole("button", { name: "/workspace" })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "src" })).toBeVisible()
  await userEvent.click(screen.getByRole("button", { name: "Show parent folders" }))
  await userEvent.click(screen.getByRole("menuitem", { name: "/workspace" }))
  expect(navigate).toHaveBeenCalledWith([])
  width = 800
  act(() => resize())
  expect(screen.queryByRole("button", { name: "Show parent folders" })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "projects" })).toBeVisible()
})

it("keeps long current names accessible and supports keyboard dismissal", async () => {
  const name = "an-exceptionally-long-current-folder-name"
  render(<FolderBreadcrumbs segments={["projects", name]} onNavigate={vi.fn()} />)
  expect(screen.getByRole("button", { name })).toHaveAttribute("title", name)
  expect(screen.getByRole("button", { name })).toHaveClass("truncate")
  const user = userEvent.setup()
  const trigger = screen.getByRole("button", { name: "Show parent folders" })
  trigger.focus()
  await user.keyboard("{ArrowDown}")
  expect(screen.getByRole("menuitem", { name: "projects" })).toHaveFocus()
  await user.keyboard("{Escape}")
  expect(trigger).toHaveFocus()
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
})
