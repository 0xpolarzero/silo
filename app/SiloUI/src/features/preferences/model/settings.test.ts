import { expect, it } from "vitest"

import { readSettingsOverrides, settingsPatchSchema } from "./settings"
import { applicationPreferenceChanges } from "./application-preferences"

it("saves the application label with a new location even when the displayed name is unchanged", () => {
  const previous = { terminal: "Terminal", editor: "Editor", browser: "Safari" }
  expect(applicationPreferenceChanges(previous, { ...previous, editorPath: "/Applications/Editor.app" }))
    .toEqual({ editor: "Editor", editorPath: "/Applications/Editor.app" })
})

it("saves only the system-default mode and pins a named choice even when it matches that default", () => {
  const previous = { terminal: "Terminal", editor: "Editor", browser: "Safari", editorPath: "/Applications/Editor.app", editorUseSystemDefault: false }
  const following = { ...previous, editorUseSystemDefault: true }
  expect(applicationPreferenceChanges(previous, following)).toEqual({ editorUseSystemDefault: true })
  expect(applicationPreferenceChanges(following, previous)).toEqual({ editor: "Editor", editorPath: "/Applications/Editor.app", editorUseSystemDefault: false })
  expect(applicationPreferenceChanges(following, { ...following, editor: "New Default", editorPath: "/Applications/New.app" })).toEqual({})
})

it("preserves application labels and locations, including a cleared legacy location", () => {
  const saved = { editor: "My Editor", editorPath: "/Users/example/Applications/My Editor.app", terminalPath: null }
  expect(readSettingsOverrides(saved)).toEqual(saved)
  expect(settingsPatchSchema.safeParse({ editorPath: "relative.app" }).success).toBe(false)
})

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
