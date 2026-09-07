import { z } from "zod"

export const applicationPathSchema = z.string().min(1).max(4096).startsWith("/").nullable()

export const applicationPreferenceSelectionSchema = z.object({
  terminal: z.string().min(1),
  editor: z.string().min(1),
  browser: z.string().min(1),
  terminalPath: applicationPathSchema.optional(),
  editorPath: applicationPathSchema.optional(),
  browserPath: applicationPathSchema.optional(),
  terminalUseSystemDefault: z.boolean().optional(),
  editorUseSystemDefault: z.boolean().optional(),
  browserUseSystemDefault: z.boolean().optional(),
}).strict()

export type ApplicationPreferenceSelection = z.infer<typeof applicationPreferenceSelectionSchema>

export function applicationPreferenceChanges(previous: ApplicationPreferenceSelection, next: ApplicationPreferenceSelection) {
  const patch: Partial<ApplicationPreferenceSelection> = {}
  for (const kind of ["terminal", "editor", "browser"] as const) {
    const path = `${kind}Path` as const
    const mode = `${kind}UseSystemDefault` as const
    if (next[mode]) {
      if (!previous[mode]) patch[mode] = true
      continue
    }
    if (previous[kind] !== next[kind] || previous[path] !== next[path] || previous[mode] !== next[mode]) {
      patch[kind] = next[kind]
      patch[path] = next[path] ?? null
      if (next[mode] !== undefined || previous[mode]) patch[mode] = false
    }
  }
  return patch
}
