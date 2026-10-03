import { act, renderHook } from "@testing-library/react"
import { expect, it } from "vitest"

import { useApplicationNavigation } from "./use-application-navigation"

it("preserves forward history when the current destination is selected again", () => {
  const { result } = renderHook(() => useApplicationNavigation(false, { computer: "a", computerTab: "checkpoints" }))
  act(() => result.current.selectSettingsSection("notifications"))
  act(() => result.current.goBack())
  act(() => result.current.openComputer("a", "checkpoints"))
  expect(result.current.canGoBack).toBe(false)
  expect(result.current.canGoForward).toBe(true)
  act(() => result.current.goForward())
  expect(result.current.tab).toBe("settings")
  expect(result.current.settingsSection).toBe("notifications")
})

it("replaces the forward branch when navigating elsewhere after Back", () => {
  const { result } = renderHook(() => useApplicationNavigation(false))
  act(() => result.current.openComputer("a", "checkpoints"))
  act(() => result.current.selectSettingsSection("notifications"))
  act(() => result.current.goBack())
  act(() => result.current.openComputer("b", "storage"))
  expect(result.current.computer).toBe("b")
  expect(result.current.canGoForward).toBe(false)
  act(() => result.current.goForward())
  expect(result.current.computer).toBe("b")
  act(() => result.current.goBack())
  expect(result.current.computer).toBe("a")
  expect(result.current.computerTab).toBe("checkpoints")
})

it("removes resolved system issues from both history directions while preserving the current position", () => {
  const { result, rerender } = renderHook(({ issue }) => useApplicationNavigation(issue), { initialProps: { issue: true } })
  act(() => result.current.selectTab("system"))
  act(() => result.current.selectSettingsSection("general"))
  act(() => result.current.selectTab("system"))
  act(() => result.current.selectSettingsSection("notifications"))
  act(() => result.current.goBack())
  expect(result.current.tab).toBe("system")

  rerender({ issue: false })
  expect(result.current.tab).toBe("computers")
  expect(result.current.computerSection).toBe("overview")
  expect(result.current.canGoForward).toBe(true)
  act(() => result.current.goForward())
  expect(result.current.settingsSection).toBe("notifications")
  act(() => result.current.goBack())
  act(() => result.current.goBack())
  expect(result.current.tab).toBe("settings")
  expect(result.current.settingsSection).toBe("general")
  act(() => result.current.goBack())
  expect(result.current.tab).toBe("computers")
  expect(result.current.canGoBack).toBe(false)

  rerender({ issue: true })
  act(() => result.current.goForward())
  expect(result.current.tab).toBe("settings")
  expect(result.current.settingsSection).toBe("general")
})

it("drops a deleted computer from history without pushing an entry or losing forward history", () => {
  const { result } = renderHook(() => useApplicationNavigation(false))
  act(() => result.current.openComputer("a"))
  act(() => result.current.selectComputerSection("files"))
  act(() => result.current.openComputer("b"))
  act(() => result.current.goBack())
  act(() => result.current.goBack())
  expect(result.current.computer).toBe("a")
  expect(result.current.canGoForward).toBe(true)

  // "a" was deleted from its own page: the current entry becomes the Computers list in place.
  act(() => result.current.forgetComputers(computer => computer !== "a"))
  expect(result.current.computer).toBeUndefined()
  expect(result.current.computerSection).toBe("overview")

  // Back reaches the list that came before, never the deleted computer, and Forward still works.
  act(() => result.current.goForward())
  expect(result.current.computerSection).toBe("files")
  act(() => result.current.goForward())
  expect(result.current.computer).toBe("b")
  act(() => result.current.goBack())
  act(() => result.current.goBack())
  expect(result.current.computer).toBeUndefined()
  expect(result.current.computerSection).toBe("overview")
  expect(result.current.canGoBack).toBe(false)
})

it("leaves history untouched while every computer still exists", () => {
  const { result } = renderHook(() => useApplicationNavigation(false))
  act(() => result.current.openComputer("a", "checkpoints"))
  const before = result.current
  act(() => result.current.forgetComputers(() => true))
  expect(result.current.computer).toBe("a")
  expect(result.current.computerTab).toBe("checkpoints")
  expect(result.current.canGoBack).toBe(before.canGoBack)
})
