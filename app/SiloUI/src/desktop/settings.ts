import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { z } from "zod"
import { onboardingDraftSchema } from "@/features/onboarding/model/onboarding-draft"
import { createSettingsStore, type SettingsBackend, type SettingsStore } from "@/features/preferences/settings-store"
import type { SettingsPatch } from "@/features/preferences/model/settings"

const nativeSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  settings: z.record(z.string(), z.unknown()),
  onboardingDraft: z.unknown().transform((draft) => {
    if (draft === null) return null
    const parsed = onboardingDraftSchema.safeParse(draft)
    if (parsed.success) return parsed.data
    console.error("Silo settings: saved onboarding draft could not be restored")
    return null
  }),
  saveError: z.string().nullable(),
})

export function createDesktopSettingsStore(initialSettings: SettingsPatch, main: boolean) {
  let firstRead = true
  const backend: SettingsBackend = {
    async read() {
      let snapshot = nativeSnapshotSchema.parse(await invoke("read_settings"))
      if (firstRead && main) {
        firstRead = false
        // Import an actual saved choice only. Retain its old key if migration fails.
        let theme: string | null = null
        try { theme = localStorage.getItem("silo-theme") } catch { /* Browser storage can be unavailable. */ }
        if (!snapshot.saveError && !("theme" in snapshot.settings) && (theme === "system" || theme === "dark" || theme === "light")) {
          snapshot = nativeSnapshotSchema.parse(await invoke("import_legacy_theme", { theme }))
        }
      }
      return snapshot
    },
    subscribe: (receive) => listen("settings:changed", ({ payload }) => {
      const parsed = nativeSnapshotSchema.safeParse(payload)
      if (parsed.success) receive(parsed.data)
      else console.error("Silo settings: invalid native event", parsed.error.message)
    }),
    updateSettings: async (patch) => nativeSnapshotSchema.parse(await invoke("update_settings", { patch })),
    updateOnboardingDraft: async (draft) => nativeSnapshotSchema.parse(await invoke("update_onboarding_draft", { draft })),
    flush: () => invoke("flush_settings"),
  }
  return createSettingsStore(backend, initialSettings)
}

export async function connectSettingsLifecycle(store: SettingsStore, main: boolean, beforeFlush: () => Promise<void> = async () => {}) {
  let stop: (() => void) | undefined
  let connecting: Promise<void> | null = null
  let disposed = false
  function connect() {
    if (stop || disposed) return Promise.resolve()
    connecting ??= (async () => {
      try {
        const unsubscribe = main
          ? await listen("settings:flush-request", () => {
              void invoke("begin_settings_flush")
                .catch((error: unknown) => console.error("Silo settings shutdown acknowledgment:", error))
                .then(beforeFlush)
                .then(() => store.flush())
                .then(() => {
                  const error = store.getSnapshot().saveError
                  if (error) throw new Error(error)
                  return invoke("complete_settings_flush")
                })
                .catch(async (error: unknown) => {
                  console.error("Silo settings shutdown:", error)
                  await invoke("cancel_settings_flush").catch((failure: unknown) => console.error("Silo could not cancel shutdown:", failure))
                })
            })
          : await listen("desktop:status-opened", () => { void store.refresh() })
        if (disposed) unsubscribe()
        else stop = unsubscribe
      } catch (error) { console.error("Silo settings lifecycle:", error) }
    })().finally(() => { connecting = null })
    return connecting
  }
  const refresh = () => { void store.refresh(); void connect() }
  window.addEventListener("focus", refresh)
  await connect()
  return () => { disposed = true; stop?.(); window.removeEventListener("focus", refresh) }
}
