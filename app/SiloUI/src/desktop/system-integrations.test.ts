import { beforeEach, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))

import { createMemorySettingsStore } from "@/features/preferences/settings-store"
import { createDesktopSystemIntegrationStore } from "./system-integrations"

beforeEach(() => native.invoke.mockReset())

it("uses only the narrow native integration commands and waits for explicit actions to mutate", async () => {
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "read_system_integrations") return {
      platform: "macos",
      loginItem: { state: "notRegistered", error: null },
      notifications: { state: "notDetermined", error: null },
    }
    if (command === "set_login_item") return { state: "enabled", error: null }
    if (command === "request_notification_authorization") return { state: "authorized", error: null }
    return undefined
  })
  const settings = createMemorySettingsStore({ launchAtLogin: true, notificationsEnabled: true })
  const store = createDesktopSystemIntegrationStore(settings)

  await store.initialize()
  expect(native.invoke.mock.calls).toEqual([["read_system_integrations"]])

  await store.setLaunchAtLogin(true)
  await store.setNotificationsEnabled(true)
  await store.openSettings("notifications")

  expect(native.invoke).toHaveBeenCalledWith("set_login_item", { enabled: true })
  expect(native.invoke).toHaveBeenCalledWith("request_notification_authorization")
  expect(native.invoke).toHaveBeenCalledWith("open_integration_settings", { integration: "notifications" })
  expect(native.invoke.mock.calls.slice(2, 4)).toEqual([
    ["read_system_integrations"],
    ["request_notification_authorization"],
  ])
})

it("maps a failed native read to unknown authority and the integration error dialog, then recovers", async () => {
  let unavailable = true
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "read_system_integrations") {
      if (unavailable) throw "System integrations unavailable"
      return { platform: "macos", loginItem: { state: "enabled", error: null }, notifications: { state: "authorized", error: null } }
    }
  })
  const settings = createMemorySettingsStore({ notificationsEnabled: true })
  const store = createDesktopSystemIntegrationStore(settings)
  try {
    await store.initialize()
    expect(store.getSnapshot().initialized).toBe(false)
    expect(native.invoke).toHaveBeenCalledWith("show_integration_error", { message: "System integrations unavailable" })
    unavailable = false
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ initialized: true, notifications: { state: "authorized" } })
    expect(native.invoke.mock.calls.filter(([command]) => command === "show_integration_error")).toHaveLength(1)
    expect(settings.getSnapshot().settings.notificationsEnabled).toBe(true)
  } finally { store.dispose() }
})

it("persists a refused login enable and clears pending state even when the error dialog fails", async () => {
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "read_system_integrations") return { platform: "macos", loginItem: { state: "enabled", error: null }, notifications: { state: "authorized", error: null } }
    if (command === "set_login_item") return { state: "error", error: "OS registration failed" }
    if (command === "show_integration_error") throw new Error("Dialog unavailable")
  })
  const settings = createMemorySettingsStore({ launchAtLogin: true })
  const store = createDesktopSystemIntegrationStore(settings)
  try {
    await store.initialize()
    await store.setLaunchAtLogin(true)
    expect(native.invoke).toHaveBeenCalledWith("set_login_item", { enabled: true })
    expect(native.invoke).toHaveBeenCalledWith("show_integration_error", { message: "OS registration failed" })
    expect(settings.getSnapshot().settings.launchAtLogin).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ loginPending: false, loginItem: { state: "error", error: "OS registration failed" } })
  } finally { store.dispose() }
})
