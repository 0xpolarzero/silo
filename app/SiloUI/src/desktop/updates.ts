import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { updateSnapshotSchema, type UpdateBackend } from "@/features/updates/update-store"

const snapshot = async (command: string, args?: Record<string, unknown>) => updateSnapshotSchema.parse(await invoke(command, args))
export const desktopUpdateBackend: UpdateBackend = {
  read: () => snapshot("get_update_state"),
  subscribe: (receive) => listen("silo://update-state", ({ payload }) => {
    const parsed = updateSnapshotSchema.safeParse(payload)
    if (parsed.success) receive(parsed.data)
    else console.error("Silo updates: invalid native state")
  }),
  check: () => snapshot("check_for_update"),
  download: () => snapshot("download_update"),
  install: (stopSandboxes) => snapshot("install_update", { stopSandboxes }),
  setAutomaticChecks: (enabled) => snapshot("set_update_automatic_checks", { enabled }),
  openRelease: () => invoke("open_update_release"),
}
