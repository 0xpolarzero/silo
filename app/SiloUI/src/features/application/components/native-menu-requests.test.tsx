import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { OverviewPage } from "../pages/overview-page"
import { ApplicationCommandMenu } from "./application-command-menu"
import { ApplicationShell } from "./application-shell"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"

const source = applicationSourceForScenario("running")
const actions = {} as ApplicationActions

it("opens the real computer form once per native request without discarding its edited draft on refresh", () => {
  const changed = vi.fn()
  const view = render(<OverviewPage source={source} actions={actions} onConfigurationsChange={changed} newComputerRequest={1} />)
  const input = screen.getByRole("textbox", { name: "Computer name" })
  fireEvent.change(input, { target: { value: "my-native-vm" } })
  view.rerender(<OverviewPage source={source} actions={actions} onConfigurationsChange={changed} newComputerRequest={1} />)
  expect(input).toHaveValue("my-native-vm")
  expect(changed).not.toHaveBeenCalled()
})
it("does not defer a new computer request received during a configuration operation", () => {
  const locked = applicationSourceForScenario("running", undefined, undefined, "add-configuring")
  const view = render(<OverviewPage source={locked} actions={actions} onConfigurationsChange={vi.fn()} newComputerRequest={1} />)
  expect(screen.queryByRole("textbox", { name: "Computer name" })).not.toBeInTheDocument()
  view.rerender(<OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} newComputerRequest={1} />)
  expect(screen.queryByRole("textbox", { name: "Computer name" })).not.toBeInTheDocument()
})
it("lets native CmdK own toggling without a duplicate DOM shortcut toggle", () => {
  const view = render(<ApplicationCommandMenu commands={[]} nativeShortcuts openRequest={1} />)
  expect(screen.getByRole("dialog", { name: "Commands" })).toBeVisible()
  fireEvent.keyDown(window, { key: "k", metaKey: true })
  expect(screen.getByRole("dialog", { name: "Commands" })).toBeVisible()
  view.rerender(<ApplicationCommandMenu commands={[]} nativeShortcuts openRequest={2} />)
  expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
})
it("does not replay a disabled command request after installation finishes", () => {
  const view = render(<ApplicationCommandMenu commands={[]} disabled openRequest={1} />)
  view.rerender(<ApplicationCommandMenu commands={[]} openRequest={1} />)
  expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
})
it("toggles the actual sidebar once per request and preserves its disabled gate", () => {
  const props = { activeTab: "computers" as const, computerSection: "overview" as const, settingsSection: "general" as const, systemIssueStatus: null, computerAttention: { errors: 0, warnings: 0 }, onTabChange: vi.fn(), onComputerSectionChange: vi.fn(), onSettingsSectionChange: vi.fn(), canGoBack: false, canGoForward: false, onGoBack: vi.fn(), onGoForward: vi.fn() }
  const view = render(<ApplicationShell {...props} toggleSidebarRequest={1}>Content</ApplicationShell>)
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
  view.rerender(<ApplicationShell {...props} toggleSidebarRequest={1}>Content</ApplicationShell>)
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
  view.rerender(<ApplicationShell {...props} toggleSidebarRequest={2} navigationDisabled>Content</ApplicationShell>)
  view.rerender(<ApplicationShell {...props} toggleSidebarRequest={2}>Content</ApplicationShell>)
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
})
it("acknowledges a computer request so its owner can clear it before an Overview remount", () => {
  const handled = vi.fn()
  const view = render(<OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} newComputerRequest={7} onNewComputerRequestHandled={handled} />)
  expect(handled).toHaveBeenCalledExactlyOnceWith(7)
  expect(screen.getByRole("textbox", { name: "Computer name" })).toBeVisible()
  view.unmount()
  render(<OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} newComputerRequest={0} onNewComputerRequestHandled={handled} />)
  expect(screen.queryByRole("textbox", { name: "Computer name" })).not.toBeInTheDocument()
  expect(handled).toHaveBeenCalledOnce()
})
it("does not open Commands over a focused unrelated dialog", () => {
  const view = render(<><div role="dialog" aria-label="Other dialog"><input aria-label="Other field" /></div><ApplicationCommandMenu commands={[]} nativeShortcuts /></>)
  screen.getByRole("textbox", { name: "Other field" }).focus()
  view.rerender(<><div role="dialog" aria-label="Other dialog"><input aria-label="Other field" /></div><ApplicationCommandMenu commands={[]} nativeShortcuts openRequest={1} /></>)
  expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
})
it("preserves and focuses an existing computer draft on another new-computer request", () => {
  const handled = vi.fn()
  const view = render(<OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} newComputerRequest={1} onNewComputerRequestHandled={handled} />)
  const name = screen.getByRole("textbox", { name: "Computer name" })
  fireEvent.change(name, { target: { value: "keep-my-draft" } })
  name.blur()
  view.rerender(<OverviewPage source={source} actions={actions} onConfigurationsChange={vi.fn()} newComputerRequest={2} onNewComputerRequestHandled={handled} />)
  expect(screen.getByRole("textbox", { name: "Computer name" })).toHaveValue("keep-my-draft")
  expect(name).toHaveFocus()
  expect(handled).toHaveBeenLastCalledWith(2)
})
