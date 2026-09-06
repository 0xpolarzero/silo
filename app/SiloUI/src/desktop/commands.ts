import { invoke } from "@tauri-apps/api/core"

export function desktopCommand(command: "hide_status" | "open_main" | "quit_app") {
  return invoke(command).catch((error: unknown) => console.error(`Desktop ${command} failed`, error))
}

