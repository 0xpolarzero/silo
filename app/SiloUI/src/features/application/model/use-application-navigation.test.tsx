import { act, renderHook } from "@testing-library/react"
import { expect, it } from "vitest"

import { useApplicationNavigation } from "./use-application-navigation"

it("drops a deleted sandbox from history without pushing an entry or losing forward history", () => {
  const { result } = renderHook(() => useApplicationNavigation(false))
  act(() => result.current.openSandbox("a"))
  act(() => result.current.selectWorkspaceSection("files"))
  act(() => result.current.openSandbox("b"))
  act(() => result.current.goBack())
  act(() => result.current.goBack())
  expect(result.current.workspace).toBe("a")
  expect(result.current.canGoForward).toBe(true)

  // "a" was deleted from its own page: the current entry becomes the Sandboxes list in place.
  act(() => result.current.forgetSandboxes(workspace => workspace !== "a"))
  expect(result.current.workspace).toBeUndefined()
  expect(result.current.workspaceSection).toBe("overview")

  // Back reaches the list that came before, never the deleted sandbox, and Forward still works.
  act(() => result.current.goForward())
  expect(result.current.workspaceSection).toBe("files")
  act(() => result.current.goForward())
  expect(result.current.workspace).toBe("b")
  act(() => result.current.goBack())
  act(() => result.current.goBack())
  expect(result.current.workspace).toBeUndefined()
  expect(result.current.workspaceSection).toBe("overview")
  expect(result.current.canGoBack).toBe(false)
})

it("leaves history untouched while every sandbox still exists", () => {
  const { result } = renderHook(() => useApplicationNavigation(false))
  act(() => result.current.openSandbox("a", "checkpoints"))
  const before = result.current
  act(() => result.current.forgetSandboxes(() => true))
  expect(result.current.workspace).toBe("a")
  expect(result.current.sandboxTab).toBe("checkpoints")
  expect(result.current.canGoBack).toBe(before.canGoBack)
})
