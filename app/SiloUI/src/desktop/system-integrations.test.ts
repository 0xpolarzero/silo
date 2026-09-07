import { beforeEach, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }))

import { createMemorySettingsStore } from "@/features/preferences/settings-store"
import { createDesktopSystemIntegrationStore, createSystemIntegrationStoreForRuntime } from "./system-integrations"

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

it("routes learned native fixture or memory storage mode to deterministic authority", async () => {
  const settings = createMemorySettingsStore({ launchAtLogin: false, notificationsEnabled: false })
  const store = createSystemIntegrationStoreForRuntime(settings, {
    desktop: true,
    main: true,
    fixtureStorage: true,
  })

  await store.initialize()
  await store.setLaunchAtLogin(true)
  await store.setNotificationsEnabled(true)

  expect(store.getSnapshot()).toMatchObject({
    platform: "fixture",
    loginItem: { state: "enabled" },
    notifications: { state: "authorized" },
  })
  expect(native.invoke).not.toHaveBeenCalled()
})
