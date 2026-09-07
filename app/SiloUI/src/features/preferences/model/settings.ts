import { z } from "zod"
import { applicationPathSchema } from "./application-preferences"

export const settingSchemas = {
  theme: z.enum(["system", "dark", "light"]),
  launchAtLogin: z.boolean(),
  startWorkspacesAtLaunch: z.boolean(),
  startupWorkspaceIds: z.array(z.string().min(1).max(256)).max(256),
  terminal: z.string().min(1).max(256),
  editor: z.string().min(1).max(256),
  browser: z.string().min(1).max(256),
  terminalPath: applicationPathSchema,
  editorPath: applicationPathSchema,
  browserPath: applicationPathSchema,
  terminalUseSystemDefault: z.boolean(),
  editorUseSystemDefault: z.boolean(),
  browserUseSystemDefault: z.boolean(),
  reduceMotion: z.boolean(),
  notificationsEnabled: z.boolean(),
  notifyHealth: z.boolean(),
  notifyActions: z.boolean(),
  notifyBackup: z.boolean(),
} as const

export const settingsSchema = z.object(settingSchemas).strict()
export const settingsPatchSchema = settingsSchema.partial()
export type Settings = z.infer<typeof settingsSchema>
export type SettingsPatch = Partial<Settings>

export const defaultSettings: Settings = {
  theme: "system",
  launchAtLogin: true,
  startWorkspacesAtLaunch: false,
  startupWorkspaceIds: [],
  terminal: "Terminal",
  editor: "Visual Studio Code",
  browser: "Safari",
  terminalPath: null,
  editorPath: null,
  browserPath: null,
  terminalUseSystemDefault: true,
  editorUseSystemDefault: true,
  browserUseSystemDefault: true,
  reduceMotion: false,
  notificationsEnabled: true,
  notifyHealth: true,
  notifyActions: true,
  notifyBackup: true,
}

// Read fields independently: one invalid field must not erase other saved choices.
// Unknown fields remain owned by the native document and never become UI settings.
export function readSettingsOverrides(input: Record<string, unknown>): SettingsPatch {
  const result: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(settingSchemas)) {
    if (!(key in input)) continue
    const parsed = schema.safeParse(input[key])
    if (parsed.success) result[key] = parsed.data
  }
  return result as SettingsPatch
}
