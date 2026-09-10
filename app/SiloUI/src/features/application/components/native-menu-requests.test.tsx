import { act, fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { OverviewPage } from "../pages/overview-page"
import { BackupPage } from "../pages/backup-page"
import { ApplicationCommandMenu } from "./application-command-menu"
import { ApplicationShell } from "./application-shell"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import type { BackupController } from "../model/backup-source"

const source = applicationSourceForScenario("running")
const actions = {} as ApplicationActions
const archive = { name: "dev.silo-backup", archivePath: "/backups/dev.silo-backup", completedLabel: "Today", size: "2 GB", destination: "/backups", sandboxes: ["dev"] }
function backup(): BackupController {
  return { state: { snapshotId: "1", availability: "available", archives: [archive], operation: null }, actions: { chooseDestination: vi.fn(), chooseArchive: vi.fn().mockResolvedValue({ valid: true, archive }), inspectArchive: vi.fn(), startBackup: vi.fn(), startRestore: vi.fn(), cancelOperation: vi.fn(), retryStart: vi.fn(), dismissOperation: vi.fn() } }
}
it("opens the real VM form once per native request without discarding its edited draft on refresh", () => {
  const changed = vi.fn()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={changed} newSandboxRequest={1} />)
  const input = screen.getByRole("textbox", { name: "Machine name" })
  fireEvent.change(input, { target: { value: "my-native-vm" } })
  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={changed} newSandboxRequest={1} />)
  expect(input).toHaveValue("my-native-vm")
  expect(changed).not.toHaveBeenCalled()
})
it("does not defer a new sandbox request received during a configuration operation", () => {
  const locked = applicationSourceForScenario("running", undefined, undefined, "add-configuring")
  const view = render(<OverviewPage source={locked} actions={actions} onMachinesChange={vi.fn()} newSandboxRequest={1} />)
  expect(screen.queryByRole("textbox", { name: "Machine name" })).not.toBeInTheDocument()
  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} newSandboxRequest={1} />)
  expect(screen.queryByRole("textbox", { name: "Machine name" })).not.toBeInTheDocument()
})
it("opens backup selection without starting a backup and consumes repeat renders", () => {
  const controller = backup()
  const view = render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "create" }} />)
  expect(screen.getByRole("group", { name: "Choose backup" })).toBeVisible()
  expect(screen.getByRole("heading", { name: "Create backup" }).closest("li")).toHaveFocus()
  view.rerender(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "create" }} />)
  expect(controller.actions.dismissOperation).toHaveBeenCalledOnce()
  expect(controller.actions.startBackup).not.toHaveBeenCalled()
})
it("uses the native archive chooser then focuses the existing restore confirmation", async () => {
  const controller = backup()
  render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "restore" }} />)
  await act(async () => { await Promise.resolve() })
  expect(controller.actions.chooseArchive).toHaveBeenCalledOnce()
  expect(screen.getByRole("textbox", { name: "New sandbox name" })).toHaveFocus()
  expect(controller.actions.startRestore).not.toHaveBeenCalled()
})
it("ignores further restore requests while the chooser is already open", async () => {
  const controller = backup()
  vi.mocked(controller.actions.chooseArchive).mockImplementation(() => new Promise(() => {}))
  const view = render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "restore" }} />)
  view.rerender(<BackupPage source={source} backup={controller} menuRequest={{ id: 2, action: "restore" }} />)
  expect(controller.actions.chooseArchive).toHaveBeenCalledOnce()
})
it("shows the existing unavailable message instead of opening a native restore chooser", () => {
  const controller = backup()
  controller.state.availability = "unavailable"
  controller.state.availabilityMessage = "Backup storage is unavailable."
  render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "restore" }} />)
  expect(screen.getByRole("alert")).toHaveTextContent("Backup storage is unavailable.")
  expect(controller.actions.chooseArchive).not.toHaveBeenCalled()
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
  const props = { activeTab: "workspaces" as const, workspaceSection: "overview" as const, settingsSection: "general" as const, systemIssueStatus: null, workspaceAttention: { errors: 0, warnings: 0 }, onTabChange: vi.fn(), onWorkspaceSectionChange: vi.fn(), onSettingsSectionChange: vi.fn(), canGoBack: false, canGoForward: false, onGoBack: vi.fn(), onGoForward: vi.fn() }
  const view = render(<ApplicationShell {...props} toggleSidebarRequest={1}>Content</ApplicationShell>)
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
  view.rerender(<ApplicationShell {...props} toggleSidebarRequest={1}>Content</ApplicationShell>)
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
  view.rerender(<ApplicationShell {...props} toggleSidebarRequest={2} navigationDisabled>Content</ApplicationShell>)
  view.rerender(<ApplicationShell {...props} toggleSidebarRequest={2}>Content</ApplicationShell>)
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible()
})
it("acknowledges a VM request so its owner can clear it before an Overview remount", () => {
  const handled = vi.fn()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} newSandboxRequest={7} onNewSandboxRequestHandled={handled} />)
  expect(handled).toHaveBeenCalledExactlyOnceWith(7)
  expect(screen.getByRole("textbox", { name: "Machine name" })).toBeVisible()
  view.unmount()
  render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} newSandboxRequest={0} onNewSandboxRequestHandled={handled} />)
  expect(screen.queryByRole("textbox", { name: "Machine name" })).not.toBeInTheDocument()
  expect(handled).toHaveBeenCalledOnce()
})
it("does not open Commands over a focused unrelated dialog", () => {
  const view = render(<><div role="dialog" aria-label="Other dialog"><input aria-label="Other field" /></div><ApplicationCommandMenu commands={[]} nativeShortcuts /></>)
  screen.getByRole("textbox", { name: "Other field" }).focus()
  view.rerender(<><div role="dialog" aria-label="Other dialog"><input aria-label="Other field" /></div><ApplicationCommandMenu commands={[]} nativeShortcuts openRequest={1} /></>)
  expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument()
})
it.each(["create", "restore"] as const)("does not start or queue %s while a native backup operation runs", (action) => {
  const controller = backup()
  controller.state.operation = { kind: "running", operation: "restore", archive, runningNames: [], progress: 20, phases: [] }
  const view = render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action }} />)
  expect(controller.actions.chooseArchive).not.toHaveBeenCalled()
  expect(controller.actions.dismissOperation).not.toHaveBeenCalled()
  view.rerender(<BackupPage source={source} backup={{ ...controller, state: { ...controller.state, operation: null } }} menuRequest={{ id: 1, action }} />)
  expect(screen.queryByRole("group", { name: "Choose backup" })).not.toBeInTheDocument()
  expect(controller.actions.chooseArchive).not.toHaveBeenCalled()
})
it("preserves and focuses an existing VM draft on another new-sandbox request", () => {
  const handled = vi.fn()
  const view = render(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} newSandboxRequest={1} onNewSandboxRequestHandled={handled} />)
  const name = screen.getByRole("textbox", { name: "Machine name" })
  fireEvent.change(name, { target: { value: "keep-my-draft" } })
  name.blur()
  view.rerender(<OverviewPage source={source} actions={actions} onMachinesChange={vi.fn()} newSandboxRequest={2} onNewSandboxRequestHandled={handled} />)
  expect(screen.getByRole("textbox", { name: "Machine name" })).toHaveValue("keep-my-draft")
  expect(name).toHaveFocus()
  expect(handled).toHaveBeenLastCalledWith(2)
})
it.each(["create", "restore"] as const)("preserves the restore name while handling another %s menu request", async (action) => {
  const controller = backup()
  const view = render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "restore" }} />)
  await act(async () => { await Promise.resolve() })
  const name = screen.getByRole("textbox", { name: "New sandbox name" })
  fireEvent.change(name, { target: { value: "keep-this-restored-name" } })
  name.blur()
  view.rerender(<BackupPage source={source} backup={controller} menuRequest={{ id: 2, action }} />)
  expect(screen.getByRole("textbox", { name: "New sandbox name" })).toHaveValue("keep-this-restored-name")
  expect(name).toHaveFocus()
  expect(controller.actions.chooseArchive).toHaveBeenCalledOnce()
})
it("focuses the create card when there are no recent backups", () => {
  const controller = backup()
  controller.state.archives = []
  render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "create" }} />)
  expect(screen.getByRole("heading", { name: "Create backup" }).closest("li")).toHaveFocus()
})
it("keeps backup interruption confirmation when another native action is requested", () => {
  const controller = backup()
  const view = render(<BackupPage source={source} backup={controller} menuRequest={{ id: 1, action: "create" }} />)
  fireEvent.click(screen.getByRole("button", { name: "Review backup" }))
  expect(screen.getByRole("group", { name: "Running sandbox interruption" })).toBeVisible()
  view.rerender(<BackupPage source={source} backup={controller} menuRequest={{ id: 2, action: "restore" }} />)
  expect(screen.getByRole("group", { name: "Running sandbox interruption" })).toBeVisible()
  expect(controller.actions.chooseArchive).not.toHaveBeenCalled()
  expect(controller.actions.startBackup).not.toHaveBeenCalled()
})
