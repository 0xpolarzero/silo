import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceFileTree } from "./workspace-file-tree"
import { createDirectoryStore, type DirectoryPage } from "../model/directory-store"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

const workspace = applicationSourceForScenario("running").workspaces[0]
const page = (name: string, kind: "file" | "folder" | "symlink" = "file"): DirectoryPage => ({
  entries: [{ name, path: `/workspace/${name}`, kind }], nextOffset: null, snapshotId: "test",
})

describe("live file tree", () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it("waits 150 ms before showing a slow folder skeleton", async () => {
    vi.useFakeTimers()
    let resolve!: (value: DirectoryPage) => void
    const store = createDirectoryStore(() => new Promise(done => { resolve = done }))
    render(<WorkspaceFileTree workspace={workspace} store={store} active />)
    act(() => { vi.advanceTimersByTime(149) })
    expect(screen.queryByRole("status", { name: "Loading folder" })).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole("status", { name: "Loading folder" })).toBeVisible()
    await act(async () => resolve(page("ready.txt")))
    expect(screen.getByText("ready.txt")).toBeVisible()
    expect(screen.queryByRole("status", { name: "Loading folder" })).not.toBeInTheDocument()
  })

  it("never shows a skeleton for a fast response", async () => {
    vi.useFakeTimers()
    let resolve!: (value: DirectoryPage) => void
    const store = createDirectoryStore(() => new Promise(done => { resolve = done }))
    render(<WorkspaceFileTree workspace={workspace} store={store} active />)
    act(() => { vi.advanceTimersByTime(100) })
    await act(async () => resolve(page("ready.txt")))
    act(() => { vi.advanceTimersByTime(100) })
    expect(screen.getByText("ready.txt")).toBeVisible()
    expect(screen.queryByRole("status", { name: "Loading folder" })).not.toBeInTheDocument()
  })

  it("shows skeletons, lazily opens folders and immediately reuses cached contents", async () => {
    const user = userEvent.setup()
    let resolve!: (value: DirectoryPage) => void
    const loader = vi.fn()
      .mockImplementationOnce(() => new Promise<DirectoryPage>((done) => { resolve = done }))
      .mockResolvedValue({ entries: [{ name: "hello.txt", path: "/workspace/src/hello.txt", kind: "file" }], nextOffset: null, snapshotId: "child" })
    const store = createDirectoryStore(loader)
    render(<WorkspaceFileTree workspace={workspace} store={store} active />)
    expect(await screen.findByRole("status", { name: "Loading folder" })).toBeVisible()
    await act(async () => resolve(page("src", "folder")))
    expect(loader).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: "Folder src" }))
    expect(await screen.findByText("hello.txt")).toBeVisible()
    expect(loader).toHaveBeenLastCalledWith(workspace.machine.name, "/workspace/src", 0, undefined)
    await user.click(screen.getByRole("button", { name: "Folder src" }))
    loader.mockImplementation(() => new Promise(() => {}))
    await user.click(screen.getByRole("button", { name: "Folder src" }))
    expect(screen.getByText("hello.txt")).toBeVisible()
    expect(screen.queryByRole("status", { name: "Loading folder" })).not.toBeInTheDocument()
  })

  it("does not request files for stopped, stale or hidden VMs", () => {
    const loader = vi.fn()
    const store = createDirectoryStore(loader)
    const { rerender } = render(<WorkspaceFileTree workspace={{ ...workspace, state: "stopped" }} store={store} active />)
    expect(screen.getByText("Start this VM to browse its files.")).toBeVisible()
    rerender(<WorkspaceFileTree workspace={{ ...workspace, freshness: "stale" }} store={store} active />)
    expect(screen.getByText("Reconnect to browse files.")).toBeVisible()
    rerender(<WorkspaceFileTree workspace={workspace} store={store} active={false} />)
    expect(loader).not.toHaveBeenCalled()
  })

  it("distinguishes empty folders, permission errors and links without following them", async () => {
    const user = userEvent.setup()
    const loader = vi.fn().mockRejectedValueOnce("Permission denied.").mockResolvedValueOnce({ entries: [], nextOffset: null, snapshotId: "empty" })
    const store = createDirectoryStore(loader)
    render(<WorkspaceFileTree workspace={workspace} store={store} active />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied.")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Empty folder.")).toBeVisible()
    loader.mockResolvedValue(page("shortcut", "symlink"))
    await act(async () => { await store.load(workspace.machine.name, "/workspace", { refresh: true }) })
    expect(screen.getByLabelText("Symbolic link")).toBeVisible()
    expect(screen.queryByRole("button", { name: /shortcut/ })).not.toBeInTheDocument()
  })

  it("keeps errors stable during automatic refresh and clears them after recovery", async () => {
    let resolve!: (value: DirectoryPage) => void
    const loader = vi.fn().mockRejectedValueOnce(new Error("private runtime details"))
      .mockImplementationOnce(() => new Promise<DirectoryPage>((done) => { resolve = done }))
    const store = createDirectoryStore(loader)
    render(<WorkspaceFileTree workspace={workspace} store={store} active />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not load this folder\.$/)
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
    act(() => { window.dispatchEvent(new Event("focus")) })
    expect(screen.getByRole("alert")).toHaveTextContent(/^Could not load this folder\.$/)
    expect(screen.queryByRole("status", { name: "Loading folder" })).not.toBeInTheDocument()
    await act(async () => resolve(page("recovered.txt")))
    expect(screen.getByText("recovered.txt")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("appends skeletons while paging without hiding current files", async () => {
    const user = userEvent.setup()
    let resolve!: (value: DirectoryPage) => void
    const loader = vi.fn().mockResolvedValueOnce({ ...page("first"), nextOffset: 200 }).mockImplementationOnce(() => new Promise<DirectoryPage>((done) => { resolve = done }))
    const store = createDirectoryStore(loader)
    render(<WorkspaceFileTree workspace={workspace} store={store} active />)
    await user.click(await screen.findByRole("button", { name: "Load more" }))
    expect(screen.getByText("first")).toBeVisible()
    expect(await screen.findByRole("status", { name: "Loading folder" })).toBeVisible()
    await act(async () => resolve(page("second")))
    await waitFor(() => expect(screen.getByText("second")).toBeVisible())
    expect(screen.getByText("first")).toBeVisible()
  })
})
