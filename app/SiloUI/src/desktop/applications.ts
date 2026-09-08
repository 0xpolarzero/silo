import { invoke } from "@tauri-apps/api/core"
import { z } from "zod"
import type { ApplicationCatalog, ApplicationKind, ApplicationService } from "@/features/preferences/application-catalog"
import { matchesApplication } from "@/features/preferences/application-catalog"
import type { SettingsStore } from "@/features/preferences/settings-store"
import type { SettingsPatch } from "@/features/preferences/model/settings"

const kinds = ["terminal", "editor", "browser"] as const
const applicationSchema = z.object({
  name: z.string().min(1).max(256), path: z.string().startsWith("/").max(4096),
  icon: z.string().startsWith("data:image/png;base64,").max(350_000).optional(),
})
const catalogSchema = z.object({
  terminal: z.array(applicationSchema), editor: z.array(applicationSchema), browser: z.array(applicationSchema),
  defaults: z.object({ terminal: z.string().optional(), editor: z.string().optional(), browser: z.string().optional() }),
})
export const emptyApplicationCatalog: ApplicationCatalog = { terminal: [], editor: [], browser: [], defaults: {} }

export function createApplicationService(store: SettingsStore): ApplicationService {
  return {
    async read() {
      const settings = store.getSnapshot().settings
      const selections = Object.fromEntries(kinds.flatMap((kind) => settings[`${kind}Path`] ? [[kind, settings[`${kind}Path`]]] : []))
      const catalog = catalogSchema.parse(await invoke("list_applications", { selections }))
      const defaults: SettingsPatch = {}
      for (const kind of kinds) {
        const selected = catalog[kind].find(({ path }) => path === catalog.defaults[kind])
          ?? catalog[kind].find((application) => matchesApplication(application, settings[kind])) ?? catalog[kind][0]
        if (selected) {
          defaults[kind] = selected.name
          defaults[`${kind}Path`] = selected.path
        } else {
          defaults[`${kind}Path`] = null
        }
      }
      // Installed defaults never overwrite an explicit saved application choice.
      store.updateDefaults(defaults)
      return catalog
    },
    async choose(kind: ApplicationKind) {
      return applicationSchema.nullable().parse(await invoke("choose_application", { kind }))
    },
  }
}
