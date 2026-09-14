import { Download, ExternalLink, RefreshCw } from "lucide-react"
import type { ApplicationCommand } from "@/features/application/components/application-commands"
import type { Updates } from "./update-store"

/** Unavailable actions are omitted, matching sandbox commands in the palette. */
export function updateCommands(updates: Updates | null, openUpdates: () => void): ApplicationCommand[] {
  if (!updates || updates.pending) return []
  const state = updates.snapshot
  if (state && ["checking", "downloading", "installing"].includes(state.phase)) return []
  const command = (id: string, label: string, icon: ApplicationCommand["icon"], action: () => void): ApplicationCommand[] => [{
    id: `updates:${id}`, label, icon, group: "Actions", keywords: ["silo", "updates", "upgrade", "version", ...(id === "install" ? ["install", "restart"] : id === "installers" ? ["download", "install", "package"] : [])],
    run: () => { openUpdates(); action() },
  }]
  if (!state) return updates.connectionError
    ? command("reconnect", "Retry loading updates", RefreshCw, updates.reconnect) : []
  if (state.packageKind === "manual" && (state.phase === "available" || state.phase === "ready" || state.retryAction === "download" || state.retryAction === "install")) {
    return command("installers", "View installers on GitHub", ExternalLink, updates.openRelease)
  }
  if (state.phase === "ready" || state.retryAction === "install") {
    return state.canInstall ? command("install", state.retryAction === "install" ? "Retry update installation" : "Restart and update", RefreshCw, updates.requestInstall) : []
  }
  if (state.phase === "available" || state.retryAction === "download") {
    return command("download", state.retryAction === "download" ? "Retry update download" : "Download update", Download, updates.download)
  }
  return command("check", state.retryAction === "check" ? "Retry checking for updates" : "Check for updates", RefreshCw, updates.check)
}
