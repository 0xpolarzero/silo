import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { GeneralPage } from "@/features/application/pages/general-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { initializeTheme } from "./theme"

let systemDark = false
let media: EventTarget
let stopTheme: (() => void) | undefined

beforeEach(() => {
  localStorage.clear()
  systemDark = false
  media = new EventTarget()
  Object.defineProperty(media, "matches", { get: () => systemDark })
  vi.stubGlobal("matchMedia", vi.fn(() => media))
})

afterEach(() => {
  cleanup()
  stopTheme?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.classList.remove("dark")
})

function setup() {
  stopTheme = initializeTheme()
  const source = applicationSourceForScenario("complete")
  const user = userEvent.setup()
  render(<GeneralPage source={source} applicationPreferences={source.preferences} onApplicationPreferencesChange={vi.fn()} reduceMotion={false} onReduceMotionChange={vi.fn()} />)
  return async (theme: string) => {
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: theme }))
  }
}

function changeSystem(dark: boolean) {
  act(() => { systemDark = dark; media.dispatchEvent(new Event("change")) })
}

it("follows system changes live and keeps explicit overrides until System is selected again", async () => {
  const select = setup()
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("System")
  changeSystem(true)
  expect(document.documentElement).toHaveClass("dark")
  await select("Light")
  expect(localStorage.getItem("silo-theme")).toBe("light")
  changeSystem(false)
  changeSystem(true)
  expect(document.documentElement).not.toHaveClass("dark")
  await select("Dark")
  changeSystem(false)
  expect(document.documentElement).toHaveClass("dark")
  await select("System")
  expect(localStorage.getItem("silo-theme")).toBe("system")
  expect(document.documentElement).not.toHaveClass("dark")
  changeSystem(true)
  expect(document.documentElement).toHaveClass("dark")
})

it("restores the saved choice before rendering", () => {
  localStorage.setItem("silo-theme", "dark")
  setup()
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark")
  expect(document.documentElement).toHaveClass("dark")
})

it("updates the appearance and setting when another app window changes or clears the preference", () => {
  setup()
  act(() => {
    localStorage.setItem("silo-theme", "dark")
    window.dispatchEvent(new StorageEvent("storage", { key: "silo-theme", storageArea: localStorage }))
  })
  expect(document.documentElement).toHaveClass("dark")
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark")
  act(() => {
    localStorage.clear()
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }))
  })
  expect(document.documentElement).not.toHaveClass("dark")
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("System")
})

it("still changes appearance when saving the preference is unavailable", async () => {
  const select = setup()
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable") })
  await select("Dark")
  expect(document.documentElement).toHaveClass("dark")
  expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark")
})
