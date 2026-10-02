import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Menu } from "@tauri-apps/api/menu"
import { describe, expect, it, vi } from "vitest"

import { remoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { fixtureDirectoryLoader } from "@/fixtures/directory-loader"
import type { StatusBarActions } from "@/features/status-bar/status-bar-types"

type Item = { text?: string; action?: () => void; items?: Item[] }
const menus: Item[][] = []
vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: vi.fn(async ({ items }: { items: Item[] }) => { menus.push(items); return { popup: async () => {}, close: async () => {} } }) },
}))
vi.mock("@tauri-apps/api/dpi", () => ({ LogicalPosition: class {} }))

const { NativeWorkspaceMenu } = await import("./native-workspace-menu")

describe("native workspace menu", () => {
  it("targets a remote sandbox by computer, not by its bare name", async () => {
    const base = applicationSourceForScenario("complete")
    const local = base.workspaces[0]!
    const workspace = {
      ...local, state: "stopped" as const,
      computer: { ...(local.computer ?? {}), id: "office", name: "office-mac", vmId: "vm-1" },
      ports: [{ port: 3000, listening: true, configured: true, scheme: "http", hostPort: 43000 }],
    } as unknown as typeof local
    const source = { ...base, workspaces: [workspace] }
    const actions: StatusBarActions = {
      listWorkspaceDirectory: fixtureDirectoryLoader(source.workspaces),
      openSilo: vi.fn(), quit: vi.fn(), refresh: vi.fn(), pushRepository: vi.fn(), dismissRepositoryPush: vi.fn(),
      startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(),
      openTerminal: vi.fn(), openEditor: vi.fn(), openSite: vi.fn(),
    }
    render(<NativeWorkspaceMenu workspace={workspace} source={source} actions={actions} onFolders={vi.fn()} onConfirm={vi.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: `Actions for ${workspace.machine.name}` }))
    await vi.waitFor(() => expect(menus).toHaveLength(1))
    const items = menus[0]!
    items.find((item) => item.text === "Start")?.action?.()
    items.find((item) => item.text?.startsWith("Open in ") && !item.text.endsWith("…"))?.action?.()
    items.find((item) => item.text === "Open in browser")?.items?.find((item) => item.text === "Port 3000")?.action?.()
    const target = remoteWorkspaceTarget("office", "vm-1")
    expect(actions.startWorkspace).toHaveBeenCalledWith(target)
    expect(actions.openTerminal).toHaveBeenCalledWith(target)
    expect(actions.openSite).toHaveBeenCalledWith(target, 3000)
  })

  it("copies the sandbox website host and forwarded port", async () => {
    menus.length = 0
    const base = applicationSourceForScenario("complete")
    const workspace = { ...base.workspaces[0]!, ports: [{ port: 3000, listening: true, configured: true, scheme: "http" as const, hostPort: 43000, host: "dev.localhost" }] }
    const source = { ...base, workspaces: [workspace] }
    const actions = {
      listWorkspaceDirectory: fixtureDirectoryLoader(source.workspaces),
      openSilo: vi.fn(), quit: vi.fn(), refresh: vi.fn(), pushRepository: vi.fn(), dismissRepositoryPush: vi.fn(),
      startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(),
      openTerminal: vi.fn(), openEditor: vi.fn(), openSite: vi.fn(),
    } satisfies StatusBarActions
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    render(<NativeWorkspaceMenu workspace={workspace} source={source} actions={actions} onFolders={vi.fn()} onConfirm={vi.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: `Actions for ${workspace.machine.name}` }))
    await vi.waitFor(() => expect(menus).toHaveLength(1))
    const sites = menus[0]!.find((item) => item.text === "Open in browser")!.items!
    expect(sites.map((item) => item.text)).toEqual(["Port 3000", undefined, "Copy port 3000 address"])
    sites.find((item) => item.text === "Copy port 3000 address")!.action!()
    expect(writeText).toHaveBeenCalledExactlyOnceWith("http://dev.localhost:43000")
  })
})


function menuProps() {
  const source = applicationSourceForScenario("complete")
  const workspace = { ...source.workspaces[0], state: "stopped" as const }
  const actions = {
    listWorkspaceDirectory: fixtureDirectoryLoader(source.workspaces),
    openSilo: vi.fn(), quit: vi.fn(), refresh: vi.fn(), pushRepository: vi.fn(), dismissRepositoryPush: vi.fn(),
    startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn(),
    openTerminal: vi.fn(), openEditor: vi.fn(), openSite: vi.fn(),
  } satisfies StatusBarActions
  return { source, workspace, actions, onFolders: vi.fn(), onConfirm: vi.fn() }
}

it("closes a late-created native menu without opening it after unmount", async () => {
  let finish!: (menu: Menu) => void
  vi.mocked(Menu.new).mockImplementationOnce(() => new Promise<Menu>(resolve => { finish = resolve }))
  const menu = { popup: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const props = menuProps()
  const { unmount } = render(<NativeWorkspaceMenu {...props} />)
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${props.workspace.machine.name}` }))
  unmount()
  await act(async () => finish(menu as unknown as Menu))
  expect(menu.popup).not.toHaveBeenCalled()
  expect(menu.close).toHaveBeenCalledOnce()
})

it("ignores captured native menu actions after unmount", async () => {
  menus.length = 0
  const props = menuProps()
  const { unmount } = render(<NativeWorkspaceMenu {...props} />)
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${props.workspace.machine.name}` }))
  const start = menus[0].find(item => item.text === "Start")!
  unmount()
  start.action!()
  expect(props.actions.startWorkspace).not.toHaveBeenCalled()
})

it("closes a tracking native menu when its controls unmount", async () => {
  let finish!: () => void
  const menu = { popup: vi.fn(() => new Promise<void>(resolve => { finish = resolve })), close: vi.fn(async () => {}) }
  vi.mocked(Menu.new).mockResolvedValueOnce(menu as unknown as Menu)
  const props = menuProps()
  const { unmount } = render(<NativeWorkspaceMenu {...props} />)
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${props.workspace.machine.name}` }))
  unmount()
  expect(menu.close).toHaveBeenCalledOnce()
  await act(async () => finish())
})
