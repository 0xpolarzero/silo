import { describe, expect, it, vi } from "vitest"

import { createMemorySettingsStore, createSettingsStore, type SettingsBackend, type SettingsSnapshot } from "./settings-store"
import {
  createSystemIntegrationStore,
  type SystemIntegrationService,
  type SystemIntegrations,
} from "./system-integrations-store"

const snapshot = (
  login: SystemIntegrations["loginItem"]["state"] = "notRegistered",
  notifications: SystemIntegrations["notifications"]["state"] = "notDetermined",
): SystemIntegrations => ({
  platform: "macos",
  loginItem: { state: login, error: login === "error" ? "Login read failed" : null },
  notifications: { state: notifications, error: notifications === "error" ? "Notification read failed" : null },
})

function service(initial = snapshot()) {
  let current = initial
  const value: SystemIntegrationService = {
    read: vi.fn(async () => current),
    setLoginItem: vi.fn(async (enabled) => {
      current = snapshot(enabled ? "enabled" : "notRegistered", current.notifications.state)
      return current.loginItem
    }),
    requestNotifications: vi.fn(async () => {
      current = snapshot(current.loginItem.state, "authorized")
      return current.notifications
    }),
    openSettings: vi.fn(async () => {}),
    showError: vi.fn(async () => {}),
  }
  return { value, set: (next: SystemIntegrations) => { current = next } }
}

describe("verified system integration state", () => {
  it("marks an explicit OS action pending until verified readback returns", async () => {
    let finish!: (status: SystemIntegrations["loginItem"]) => void
    const settings = createMemorySettingsStore({ launchAtLogin: false })
    const native = service(snapshot("notRegistered", "authorized"))
    vi.mocked(native.value.setLoginItem).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()

    const action = store.setLaunchAtLogin(true)
    expect(store.getSnapshot().loginPending).toBe(true)
    expect(store.getSnapshot().loginItem.state).toBe("notRegistered")
    finish({ state: "enabled", error: null })
    await action

    expect(store.getSnapshot().loginPending).toBe(false)
    expect(store.getSnapshot().loginItem.state).toBe("enabled")
  })

  it.each([true, false])("never replays a saved or default launchAtLogin=%s value into the OS", async (saved) => {
    const settings = createMemorySettingsStore({ launchAtLogin: saved })
    const native = service(snapshot("notRegistered", "authorized"))
    const store = createSystemIntegrationStore(native.value, settings)

    await store.initialize()
    await store.refresh()

    expect(store.getSnapshot().loginItem.state).toBe("notRegistered")
    expect(native.value.setLoginItem).not.toHaveBeenCalled()
    expect(settings.getSnapshot().settings.launchAtLogin).toBe(saved)
  })

  it("shows approval-needed as off and saves only the verified effective result", async () => {
    const settings = createMemorySettingsStore({ launchAtLogin: true })
    const native = service(snapshot("notRegistered", "authorized"))
    vi.mocked(native.value.setLoginItem).mockResolvedValueOnce({ state: "requiresApproval", error: null })
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()

    await store.setLaunchAtLogin(true)

    expect(store.getSnapshot().loginItem.state).toBe("requiresApproval")
    expect(settings.getSnapshot().settings.launchAtLogin).toBe(false)
    expect(native.value.showError).not.toHaveBeenCalled()
  })

  it("follows an external login-item disable on refresh without writing preferences", async () => {
    const settings = createMemorySettingsStore({ launchAtLogin: true })
    const update = vi.spyOn(settings, "updateSettings")
    const native = service(snapshot("enabled", "authorized"))
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()
    native.set(snapshot("notRegistered", "authorized"))

    await store.refresh()

    expect(store.getSnapshot().loginItem.state).toBe("notRegistered")
    expect(update).not.toHaveBeenCalled()
  })

  it("does not let a slow focus read overwrite a confirmed login mutation", async () => {
    let finishRead!: (value: SystemIntegrations) => void
    const settings = createMemorySettingsStore()
    const native = service(snapshot("notRegistered", "authorized"))
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()
    vi.mocked(native.value.read).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))

    const focusRead = store.refresh()
    await store.setLaunchAtLogin(true)
    finishRead(snapshot("notRegistered", "authorized"))
    await focusRead

    expect(store.getSnapshot().loginItem.state).toBe("enabled")
    expect(settings.getSnapshot().settings.launchAtLogin).toBe(true)
  })

  it("reflects a denied notification request as off and never exposes false authorization", async () => {
    const settings = createMemorySettingsStore({ notificationsEnabled: true })
    const native = service(snapshot("enabled", "notDetermined"))
    vi.mocked(native.value.requestNotifications).mockResolvedValueOnce({ state: "denied", error: null })
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()

    await store.setNotificationsEnabled(true)

    expect(store.getSnapshot().notifications.state).toBe("denied")
    expect(settings.getSnapshot().settings.notificationsEnabled).toBe(false)
    expect(native.value.requestNotifications).toHaveBeenCalledOnce()
  })

  it("freshly reads authorization on every explicit notification enable", async () => {
    const settings = createMemorySettingsStore({ notificationsEnabled: true })
    const native = service(snapshot("enabled", "authorized"))
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()
    native.set(snapshot("enabled", "denied"))

    await store.setNotificationsEnabled(true)

    expect(native.value.read).toHaveBeenCalledTimes(2)
    expect(native.value.requestNotifications).not.toHaveBeenCalled()
    expect(store.getSnapshot().notifications.state).toBe("denied")
    expect(settings.getSnapshot().settings.notificationsEnabled).toBe(false)
  })

  it("keeps authority unknown and controls disabled when the initial read fails", async () => {
    const settings = createMemorySettingsStore()
    const native = service()
    vi.mocked(native.value.read).mockRejectedValueOnce(new Error("Native read failed"))
    const store = createSystemIntegrationStore(native.value, settings)

    await store.initialize()

    expect(store.getSnapshot().initialized).toBe(false)
    expect(native.value.showError).toHaveBeenCalledWith("Native read failed")
    expect(native.value.setLoginItem).not.toHaveBeenCalled()
    expect(native.value.requestNotifications).not.toHaveBeenCalled()
  })

  it("does not request permission after an explicit enable preflight read fails", async () => {
    const settings = createMemorySettingsStore({ notificationsEnabled: false })
    const native = service(snapshot("enabled", "authorized"))
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()
    vi.mocked(native.value.read).mockRejectedValueOnce(new Error("Settings unavailable"))

    await store.setNotificationsEnabled(true)

    expect(store.getSnapshot().initialized).toBe(false)
    expect(native.value.requestNotifications).not.toHaveBeenCalled()
    expect(settings.getSnapshot().settings.notificationsEnabled).toBe(false)
  })

  it("does not retry a failed OS intent during an ordinary preference edit or flush", async () => {
    const settings = createMemorySettingsStore()
    const native = service(snapshot("notRegistered", "authorized"))
    vi.mocked(native.value.setLoginItem).mockRejectedValueOnce(new Error("Registration failed"))
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()

    await store.setLaunchAtLogin(true)
    await settings.updateSettings({ theme: "dark" })
    await settings.flush()

    expect(native.value.setLoginItem).toHaveBeenCalledOnce()
    expect(store.getSnapshot().loginItem.state).toBe("notRegistered")
    expect(native.value.showError).toHaveBeenCalledWith("Registration failed")
  })

  it("retains a verified OS result when saving its preference reports a disk error", async () => {
    const initial: SettingsSnapshot = { revision: 0, settings: {}, onboardingDraft: null, saveError: null }
    const failed: SettingsSnapshot = { revision: 1, settings: { launchAtLogin: true }, onboardingDraft: null, saveError: "Disk full" }
    const backend: SettingsBackend = {
      read: async () => initial,
      subscribe: async () => () => {},
      updateSettings: async () => failed,
      updateOnboardingDraft: async () => initial,
      flush: async () => {},
    }
    const settings = createSettingsStore(backend)
    await settings.initialize()
    const native = service(snapshot("notRegistered", "authorized"))
    const store = createSystemIntegrationStore(native.value, settings)
    await store.initialize()

    await store.setLaunchAtLogin(true)

    expect(store.getSnapshot().loginItem.state).toBe("enabled")
    expect(native.value.setLoginItem).toHaveBeenCalledOnce()
    expect(native.value.showError).toHaveBeenCalledWith("Disk full")
  })

  it("reports initial read failures once and stays quiet on later focus refreshes", async () => {
    const settings = createMemorySettingsStore()
    const native = service(snapshot("error", "error"))
    const store = createSystemIntegrationStore(native.value, settings)

    await store.initialize()
    await store.refresh()

    expect(native.value.showError).toHaveBeenCalledOnce()
    expect(native.value.showError).toHaveBeenCalledWith("Login read failed\nNotification read failed")
  })

})
