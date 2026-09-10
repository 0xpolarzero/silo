import { act, fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { ShortcutBadge } from "./shortcut-badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip"
import { ApplicationShell } from "@/features/application/components/application-shell"
import { ApplicationTitleBar } from "@/features/application/components/application-title-bar"
import { WindowToolbar } from "./window-toolbar"
import { shortcutFor } from "@/lib/shortcuts"

const props = { activeTab: "github" as const, workspaceSection: "overview" as const, settingsSection: "general" as const, systemIssueStatus: null, workspaceAttention: { errors: 0, warnings: 0 }, onTabChange: vi.fn(), onWorkspaceSectionChange: vi.fn(), onSettingsSectionChange: vi.fn(), canGoBack: false, canGoForward: false, onGoBack: vi.fn(), onGoForward: vi.fn() }
it("renders shared keycaps without changing the control's accessible name", () => {
  render(<button aria-keyshortcuts="Meta+K">Search<ShortcutBadge shortcut={{ keys: ["⌘", "K"], aria: "Meta+K" }} /></button>)
  const button = screen.getByRole("button", { name: "Search" })
  expect(button.querySelector("kbd")).toHaveTextContent("⌘K")
  expect(button.querySelector("kbd")).toHaveAttribute("aria-hidden", "true")
  expect(button).toHaveAttribute("aria-keyshortcuts", "Meta+K")
})
it("includes the same badge in tooltip content", async () => {
  render(<TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><button aria-keyshortcuts="Meta+K">Search</button></TooltipTrigger><TooltipContent shortcut={{ keys: ["⌘", "K"], aria: "Meta+K" }}>Search</TooltipContent></Tooltip></TooltipProvider>)
  act(() => screen.getByRole("button", { name: "Search" }).focus())
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Search⌘K")
})
it("keeps expanded shortcuts mounted at the far right after status indicators for hover and focus", () => {
  render(<ApplicationShell {...props} navigationLoading={{ tabs: { github: true } }}>Content</ApplicationShell>)
  const button = screen.getByRole("button", { name: "GitHub" })
  const badge = button.querySelector("kbd")
  expect(badge).toBe(button.lastElementChild)
  expect(badge).toHaveClass("opacity-0", "group-hover/sidebar-item:opacity-100", "group-focus-visible/sidebar-item:opacity-100")
  expect(button).toHaveAttribute("aria-keyshortcuts", shortcutFor("go-github")!.aria)
  fireEvent.pointerEnter(button)
  expect(button.querySelector("kbd")).toBe(badge)
  fireEvent.pointerLeave(button)
  expect(button.querySelector("kbd")).toBe(badge)
})
it("uses the collapsed tooltip for shortcuts instead of crowding sidebar icons", async () => {
  render(<ApplicationShell {...props}>Content</ApplicationShell>)
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }))
  const button = screen.getByRole("button", { name: "GitHub" })
  expect(button.querySelector("kbd")).toBeNull()
  act(() => button.focus())
  expect(await screen.findByRole("tooltip")).toHaveTextContent(`GitHub${shortcutFor("go-github")!.keys.join("")}`)
})
it("only advertises toolbar shortcuts when the application explicitly supplies them", () => {
  const toolbar = { title: "Setup", sidebarId: "setup", collapsed: false, previewing: false, toggleRef: { current: null }, onToggleSidebar: vi.fn(), onPreviewEnter: vi.fn(), onPreviewLeave: vi.fn() }
  const view = render(<TooltipProvider><WindowToolbar {...toolbar} /></TooltipProvider>)
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).not.toHaveAttribute("aria-keyshortcuts")
  view.rerender(<TooltipProvider><ApplicationTitleBar {...toolbar} canGoBack canGoForward onGoBack={vi.fn()} onGoForward={vi.fn()} /></TooltipProvider>)
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-keyshortcuts", shortcutFor("toggle-sidebar")!.aria)
  expect(screen.getByRole("button", { name: "Go back" })).toHaveAttribute("aria-keyshortcuts", shortcutFor("go-back")!.aria)
  expect(screen.getByRole("button", { name: "Go forward" })).toHaveAttribute("aria-keyshortcuts", shortcutFor("go-forward")!.aria)
})
it("keeps history buttons disabled with the rest of the titlebar during installation", () => {
  render(<TooltipProvider><ApplicationTitleBar disabled collapsed={false} previewing={false} toggleRef={{ current: null }} onToggleSidebar={vi.fn()} onPreviewEnter={vi.fn()} onPreviewLeave={vi.fn()} canGoBack canGoForward onGoBack={vi.fn()} onGoForward={vi.fn()} /></TooltipProvider>)
  expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled()
})
