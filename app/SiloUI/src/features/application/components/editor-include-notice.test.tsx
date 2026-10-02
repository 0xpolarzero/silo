import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { EditorIncludeProvider } from "@/features/application/model/editor-include"
import { createMemorySettingsStore, createSettingsStore, SettingsProvider, type SettingsStore } from "@/features/preferences/settings-store"
import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createFixtureEditorInclude, fixtureEditorIncludeLine } from "@/fixtures/editor-include"
import { EditorIncludeNotice } from "./editor-include-notice"

type Backend = ReturnType<typeof createFixtureEditorInclude>

function notice(store: SettingsStore, backend: Backend) {
  return <SettingsProvider store={store}><EditorIncludeProvider backend={backend}><EditorIncludeNotice /></EditorIncludeProvider></SettingsProvider>
}

const region = { name: "Add a line to your SSH configuration" }
const otherLine = 'Include "/Users/ada/.silo/a81e55c0d2f4/ssh/*.conf"'

it("shows a repair notice created before native listener registration finishes", async () => {
  const backend = createFixtureEditorInclude(null)
  let register!: () => void
  const registration = new Promise<void>(resolve => { register = resolve })
  const subscribe = backend.subscribe
  backend.subscribe = async handler => { await registration; return subscribe(handler) }
  render(notice(createMemorySettingsStore(), backend))
  await act(async () => {})
  backend.set(fixtureEditorIncludeLine)
  await act(async () => register())
  expect(await screen.findByRole("region", region)).toHaveTextContent(fixtureEditorIncludeLine)
})

it("keeps a corrected SSH configuration hidden when an older read finishes later", async () => {
  const backend = createFixtureEditorInclude()
  let finish!: (line: string | null) => void
  const read = backend.read
  backend.read = vi.fn().mockImplementationOnce(() => new Promise<string | null>(resolve => { finish = resolve })).mockImplementation(read)
  render(notice(createMemorySettingsStore(), backend))

  act(() => backend.set(null))
  await waitFor(() => expect(backend.read).toHaveBeenCalledTimes(2))
  await act(async () => finish(fixtureEditorIncludeLine))
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()

  act(() => backend.set(otherLine))
  expect(await screen.findByRole("region", region)).toHaveTextContent(otherLine)
})

it("ignores a replaced backend's pending read", async () => {
  const first = createFixtureEditorInclude()
  let finishRead!: (line: string | null) => void
  first.read = vi.fn(() => new Promise<string | null>(resolve => { finishRead = resolve }))
  const store = createMemorySettingsStore()
  const view = render(notice(store, first))
  await waitFor(() => expect(first.read).toHaveBeenCalledOnce())
  const second = createFixtureEditorInclude(otherLine)
  view.rerender(notice(store, second))
  expect(await screen.findByRole("region", region)).toHaveTextContent(otherLine)
  await act(async () => finishRead(fixtureEditorIncludeLine))
  expect(screen.getByRole("region", region)).toHaveTextContent(otherLine)
  expect(screen.getByRole("region", region)).not.toHaveTextContent(fixtureEditorIncludeLine)

  fireEvent.focus(window)
  await waitFor(() => expect(second.calls).toEqual(["read", "read"]))
  expect(first.read).toHaveBeenCalledOnce()
})

it("releases a replaced backend's late subscription without starting a read", async () => {
  const first = createFixtureEditorInclude()
  let finishSubscribe!: (stop: () => void) => void
  first.read = vi.fn(async () => fixtureEditorIncludeLine)
  first.subscribe = vi.fn(() => new Promise<() => void>(resolve => { finishSubscribe = resolve }))
  const store = createMemorySettingsStore()
  const view = render(notice(store, first))
  view.rerender(notice(store, createFixtureEditorInclude(otherLine)))
  expect(await screen.findByRole("region", region)).toHaveTextContent(otherLine)
  const stop = vi.fn()
  await act(async () => finishSubscribe(stop))
  expect(stop).toHaveBeenCalledOnce()
  expect(first.read).not.toHaveBeenCalled()
  expect(screen.getByRole("region", region)).toHaveTextContent(otherLine)
})

it("shows the line to add with its explanation and a copy button, until dismissed", async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
  const store = createMemorySettingsStore()
  render(notice(store, createFixtureEditorInclude()))
  const section = await screen.findByRole("region", region)
  expect(section).toHaveTextContent("Silo couldn't update your SSH config, which links to a file it can't change. Add this line at the top so editors reconnect to your current sandboxes.")
  expect(section).toHaveTextContent(fixtureEditorIncludeLine)

  await user.click(screen.getByRole("button", { name: "Copy line to add" }))
  expect(writeText).toHaveBeenCalledWith(fixtureEditorIncludeLine)
  // Copying is not dismissing.
  expect(screen.getByRole("region", region)).toBeInTheDocument()
  expect(store.getSnapshot().settings.editorIncludeNoticeDismissed).toBeNull()

  await user.click(screen.getByRole("button", { name: "Got it" }))
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
  expect(store.getSnapshot().settings.editorIncludeNoticeDismissed).toBe(fixtureEditorIncludeLine)
})

it("closes from the dismiss button", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore()
  render(notice(store, createFixtureEditorInclude()))
  await user.click(await screen.findByRole("button", { name: "Dismiss SSH configuration notice" }))
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
  expect(store.getSnapshot().settings.editorIncludeNoticeDismissed).toBe(fixtureEditorIncludeLine)
})

it("stays hidden after a remount and after a restart that restores the saved dismissal", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore()
  const view = render(notice(store, createFixtureEditorInclude()))
  await user.click(await screen.findByRole("button", { name: "Got it" }))
  view.unmount()

  const backend = createFixtureEditorInclude()
  const remounted = render(notice(store, backend))
  await waitFor(() => expect(backend.calls).toEqual(["read"]))
  await act(async () => {})
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
  remounted.unmount()

  // A restart reads the saved dismissal back from the settings file.
  const restarted = createMemorySettingsStore({ editorIncludeNoticeDismissed: store.getSnapshot().settings.editorIncludeNoticeDismissed })
  const second = createFixtureEditorInclude()
  render(notice(restarted, second))
  await waitFor(() => expect(second.calls).toEqual(["read"]))
  await act(async () => {})
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
})

it("shows the notice again for a different needed line", async () => {
  const user = userEvent.setup()
  const store = createMemorySettingsStore()
  const backend = createFixtureEditorInclude()
  render(notice(store, backend))
  await user.click(await screen.findByRole("button", { name: "Got it" }))
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()

  act(() => backend.set(otherLine))
  const section = await screen.findByRole("region", region)
  expect(section).toHaveTextContent(otherLine)
  expect(section).not.toHaveTextContent(fixtureEditorIncludeLine)
  await user.click(screen.getByRole("button", { name: "Got it" }))
  expect(store.getSnapshot().settings.editorIncludeNoticeDismissed).toBe(otherLine)

  // The earlier line is needed again (the user removed it): that dismissal was replaced.
  act(() => backend.set(fixtureEditorIncludeLine))
  expect(await screen.findByRole("region", region)).toHaveTextContent(fixtureEditorIncludeLine)
})

it("disappears without a dismissal once the line is no longer needed", async () => {
  const store = createMemorySettingsStore()
  const backend = createFixtureEditorInclude()
  render(notice(store, backend))
  expect(await screen.findByRole("region", region)).toBeInTheDocument()

  // The user added the line: Silo tells the application, which reads again.
  act(() => backend.set(null))
  await waitFor(() => expect(screen.queryByRole("region", region)).not.toBeInTheDocument())
  expect(store.getSnapshot().settings.editorIncludeNoticeDismissed).toBeNull()

  // The line is needed again, for instance because the user removed it.
  act(() => backend.set(fixtureEditorIncludeLine))
  expect(await screen.findByRole("region", region)).toBeInTheDocument()
})

it("reads again when the window regains focus", async () => {
  const backend = createFixtureEditorInclude()
  render(notice(createMemorySettingsStore(), backend))
  await screen.findByRole("region", region)
  const reads = backend.calls.length
  fireEvent.focus(window)
  await waitFor(() => expect(backend.calls.length).toBe(reads + 1))
})

it("shows nothing when no line is needed or the backend is missing", async () => {
  const backend = createFixtureEditorInclude(null)
  const view = render(notice(createMemorySettingsStore(), backend))
  await waitFor(() => expect(backend.calls).toEqual(["read"]))
  await act(async () => {})
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
  view.unmount()

  render(<SettingsProvider store={createMemorySettingsStore()}><EditorIncludeNotice /></SettingsProvider>)
  await act(async () => {})
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
})

it("stays hidden until saved settings are read", async () => {
  const store = createSettingsStore({
    read: () => new Promise(() => {}),
    subscribe: async () => () => {},
    updateSettings: () => new Promise(() => {}),
    updateOnboardingDraft: () => new Promise(() => {}),
    flush: async () => {},
  })
  const backend = createFixtureEditorInclude()
  render(notice(store, backend))
  await waitFor(() => expect(backend.calls).toEqual(["read"]))
  await act(async () => {})
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
})

it("keeps reading when a read fails, and shows the notice once one succeeds", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const backend = createFixtureEditorInclude()
  const read = backend.read
  let failing = true
  backend.read = async () => { if (failing) throw new Error("Silo could not read the SSH configuration."); return read() }
  render(notice(createMemorySettingsStore(), backend))
  await waitFor(() => expect(error).toHaveBeenCalledWith("Silo editor connections:", "Silo could not read the SSH configuration."))
  expect(screen.queryByRole("region", region)).not.toBeInTheDocument()
  failing = false
  act(() => backend.set(fixtureEditorIncludeLine))
  expect(await screen.findByRole("region", region)).toBeInTheDocument()
  error.mockRestore()
})

it("appears in the application shell next to the other notices", async () => {
  const backend = createFixtureEditorInclude()
  render(<ApplicationPreview source={applicationSourceForScenario("running")} editorInclude={backend} />)
  expect(await screen.findByRole("region", region)).toHaveTextContent(fixtureEditorIncludeLine)
  expect(screen.getByRole("region", { name: "Silo is in alpha" })).toBeInTheDocument()
})
