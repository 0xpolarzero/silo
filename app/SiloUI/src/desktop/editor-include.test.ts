import { beforeEach, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }))

import { desktopEditorIncludeBackend } from "./editor-include"

beforeEach(() => { native.invoke.mockReset(); native.listen.mockReset() })

it("reads the line from the native command and accepts none", async () => {
  native.invoke.mockResolvedValueOnce('Include "/Users/ada/.silo/3f9c1a7be204/ssh/*.conf"').mockResolvedValueOnce(null)
  await expect(desktopEditorIncludeBackend.read()).resolves.toBe('Include "/Users/ada/.silo/3f9c1a7be204/ssh/*.conf"')
  await expect(desktopEditorIncludeBackend.read()).resolves.toBeNull()
  expect(native.invoke.mock.calls).toEqual([["read_editor_include_notice"], ["read_editor_include_notice"]])
})

it("refuses an answer that is not a line", async () => {
  native.invoke.mockResolvedValueOnce("").mockResolvedValueOnce({ line: "Include x" })
  await expect(desktopEditorIncludeBackend.read()).rejects.toThrow()
  await expect(desktopEditorIncludeBackend.read()).rejects.toThrow()
})

it("refreshes when Silo reports that the line changed", async () => {
  const stop = vi.fn()
  native.listen.mockResolvedValueOnce(stop)
  const refresh = vi.fn()
  await expect(desktopEditorIncludeBackend.subscribe(refresh)).resolves.toBe(stop)
  expect(native.listen).toHaveBeenCalledWith("silo://editor-include-changed", refresh)
})
