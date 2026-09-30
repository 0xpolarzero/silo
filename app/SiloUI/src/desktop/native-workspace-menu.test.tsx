import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("copies each site's own address, like the preview menu, instead of a port-less base URL", async () => {
    menus.length = 0
    const base = applicationSourceForScenario("complete")
    const workspace = { ...base.workspaces[0]!, ports: [{ port: 3000, listening: true, configured: true, scheme: "http" as const, hostPort: 43000 }] }
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
    expect(writeText).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:43000")
  })
})
