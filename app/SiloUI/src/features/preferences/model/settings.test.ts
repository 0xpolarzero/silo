import { expect, it } from "vitest"

import { readSettingsOverrides, settingsPatchSchema } from "./settings"

it("keeps valid saved choices when another field is malformed and leaves unknown data untouched", () => {
  const saved = {
    theme: "dark",
    browser: "A browser no longer installed",
    notificationsEnabled: "false",
    startupWorkspaceIds: ["sandbox-a", 12],
    futureSetting: { enabled: true },
  }
  const original = structuredClone(saved)
  expect(readSettingsOverrides(saved)).toEqual({ theme: "dark", browser: "A browser no longer installed" })
  expect(saved).toEqual(original)
})

it("preserves explicit false values, empty startup selections, and unavailable application choices", () => {
  const saved = {
    launchAtLogin: false,
    startWorkspacesAtLaunch: false,
    startupWorkspaceIds: [],
    terminal: "Unavailable terminal",
    editor: "Unavailable editor",
    notificationsEnabled: false,
    notifyHealth: false,
  }
  expect(readSettingsOverrides(saved)).toEqual(saved)
  expect(settingsPatchSchema.parse(saved)).toEqual(saved)
})

it.each([
  { theme: "automatic", browser: "Firefox" },
  { notifyActions: "false" },
  { terminal: "" },
  { startupWorkspaceIds: [""] },
  { futureSetting: true },
])("rejects an invalid settings write without accepting a partial edit: %j", (patch) => {
  expect(settingsPatchSchema.safeParse(patch).success).toBe(false)
})
