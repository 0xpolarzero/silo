import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { LinuxMenuButton } from "./linux-menu-button"

const native = vi.hoisted(() => ({ desktop: true, invoke: vi.fn(async () => {}) }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.desktop, invoke: native.invoke }))
afterEach(() => { vi.restoreAllMocks(); native.desktop = true; native.invoke.mockReset() })
it("opens the native Linux menu with a visible button", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64")
  render(<LinuxMenuButton />)
  const button = screen.getByRole("button", { name: "Menu" })
  expect(button).toHaveTextContent("Menu")
  expect(button).toHaveAttribute("aria-keyshortcuts", "Alt F10")
  fireEvent.click(button)
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("show_app_menu"))
})
it("leaves macOS menus and browser previews unchanged", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
  const { rerender } = render(<LinuxMenuButton />)
  expect(screen.queryByRole("button", { name: "Menu" })).not.toBeInTheDocument()
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64")
  native.desktop = false
  rerender(<LinuxMenuButton />)
  expect(screen.queryByRole("button", { name: "Menu" })).not.toBeInTheDocument()
})
it("blocks menu opening during installation and reports native failures", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux aarch64")
  const { rerender } = render(<><Toaster /><LinuxMenuButton disabled /></>)
  fireEvent.click(screen.getByRole("button", { name: "Menu" }))
  expect(native.invoke).not.toHaveBeenCalled()
  rerender(<><Toaster /><LinuxMenuButton /></>)
  native.invoke.mockRejectedValueOnce(new Error("native details"))
  fireEvent.click(screen.getByRole("button", { name: "Menu" }))
  expect(await screen.findByText("Could not open the menu")).toBeInTheDocument()
  expect(screen.getByText("native details")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2))
})
