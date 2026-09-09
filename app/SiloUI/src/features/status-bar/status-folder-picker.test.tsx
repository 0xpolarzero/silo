import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { DirectoryPage } from "@/features/application/model/directory-store"
import { StatusFolderPicker } from "./status-folder-picker"

const workspace = applicationSourceForScenario("running").workspaces[0]
const page = (names: string[], parent = "/workspace", nextOffset: number | null = null): DirectoryPage => ({
  snapshotId: parent, entries: names.map(name => ({ name, path: `${parent}/${name}`, kind: "folder" })), nextOffset,
})
function setup(loader = vi.fn().mockResolvedValue(page([]))) {
  const onOpen = vi.fn()
  const props = { workspace, editor: "Cursor", onBack: vi.fn(), onOpen, listDirectory: loader }
  return { user: userEvent.setup(), loader, props, onOpen, ...render(<StatusFolderPicker {...props} />) }
}
describe("status folder picker live directories", () => {
  it("loads lazily, opens the exact path, and keeps cached folders on return", async () => {
    let resolve!: (value: DirectoryPage) => void
    const loader = vi.fn().mockImplementationOnce(() => new Promise<DirectoryPage>(done => { resolve = done })).mockResolvedValueOnce(page(["nested"], "/workspace/project"))
    const { user, onOpen } = setup(loader)
    expect(screen.getByRole("status", { name: "Loading folders" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeDisabled()
    expect(loader).toHaveBeenCalledExactlyOnceWith(workspace.machine.name, "/workspace", 0, undefined)
    await act(async () => resolve(page(["project"])))
    await user.click(screen.getByRole("button", { name: "project" }))
    expect(await screen.findByRole("button", { name: "nested" })).toBeVisible()
    expect(loader).toHaveBeenLastCalledWith(workspace.machine.name, "/workspace/project", 0, undefined)
    await user.click(screen.getByRole("button", { name: "Open in Cursor" }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("/workspace/project")
    loader.mockImplementation(() => new Promise(() => {}))
    await user.click(screen.getByRole("button", { name: "/workspace" }))
    expect(screen.getByRole("button", { name: "project" })).toBeVisible()
    expect(screen.queryByRole("status", { name: "Loading folders" })).not.toBeInTheDocument()
  })
  it("keeps a compact error stable during retry without raw runtime output", async () => {
    let resolve!: (value: DirectoryPage) => void
    const loader = vi.fn().mockRejectedValueOnce(new Error("private runtime details")).mockImplementationOnce(() => new Promise<DirectoryPage>(done => { resolve = done }))
    const { user } = setup(loader)
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not load this folder\.$/)
    expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeDisabled()
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.getByRole("alert")).toHaveTextContent(/^Could not load this folder\.$/)
    expect(screen.queryByRole("status", { name: "Loading folders" })).not.toBeInTheDocument()
    await act(async () => resolve(page([])))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("No subfolders here")).toBeVisible()
    expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeEnabled()
  })
  it.each(["stopped", "stale"])("does not load or open a %s VM", (state) => {
    const loader = vi.fn()
    render(<StatusFolderPicker workspace={{ ...workspace, ...(state === "stopped" ? { state: "stopped" } : { freshness: "stale" }) }} editor="Cursor" onBack={vi.fn()} onOpen={vi.fn()} listDirectory={loader} />)
    expect(screen.getByText(state === "stopped" ? "Start this VM to browse its files." : "Reconnect to browse files.")).toBeVisible()
    expect(loader).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeDisabled()
  })
  it("pages beyond files without a false empty state and filters loaded folders", async () => {
    const loader = vi.fn().mockResolvedValueOnce({ ...page([], "/workspace", 200), entries: [{ name: "readme", path: "/workspace/readme", kind: "file" }] }).mockResolvedValueOnce(page(["later", "another"]))
    const { user } = setup(loader)
    await screen.findByRole("button", { name: "Load more" })
    expect(screen.queryByText("No subfolders here")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "readme" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Load more" }))
    expect(await screen.findByRole("button", { name: "later" })).toBeVisible()
    expect(loader).toHaveBeenLastCalledWith(workspace.machine.name, "/workspace", 200, "/workspace")
    await user.type(screen.getByRole("textbox", { name: "Filter folders" }), "LATE")
    expect(screen.getByRole("button", { name: "later" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "another" })).not.toBeInTheDocument()
  })
  it("never falls back to fixture files without a loader", async () => {
    render(<StatusFolderPicker workspace={workspace} editor="Cursor" onBack={vi.fn()} onOpen={vi.fn()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Files are unavailable.")
    expect(screen.queryByRole("button", { name: "projects" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeDisabled()
  })
  it("does not poll after the status panel loses focus or unmounts", async () => {
    vi.useFakeTimers()
    try {
      const { loader, unmount } = setup()
      await act(async () => {})
      act(() => window.dispatchEvent(new Event("blur")))
      await act(async () => vi.advanceTimersByTime(20_000))
      expect(loader).toHaveBeenCalledTimes(1)
      act(() => window.dispatchEvent(new Event("focus")))
      await act(async () => {})
      expect(loader).toHaveBeenCalledTimes(2)
      unmount()
      await act(async () => vi.advanceTimersByTime(20_000))
      expect(loader).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})
