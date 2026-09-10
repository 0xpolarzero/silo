import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../../src-tauri")
const shared = ["remote_host_list", "remote_host_snapshot", "remote_management_status", "remote_workspace_action", "remote_network_state", "remote_open_network_port", "read_application_shell", "read_shutdown_state"]
const management = ["set_remote_management", "connect_remote_host", "remove_remote_host", "remote_authorize_ssh", "remote_setup_ssh_key", "remote_upsert_machine", "remote_delete_machine", "remote_save_network_port", "remote_remove_network_port", "cancel_settings_flush"]
const capabilities = readdirSync(resolve(native, "capabilities"))
  .filter(name => name.endsWith(".json"))
  .map(name => JSON.parse(readFileSync(resolve(native, "capabilities", name), "utf8")) as { windows: string[]; permissions: string[] })
const permissions = (window: string) => capabilities.filter(capability => capability.windows.includes(window) || capability.windows.includes("*")).flatMap(capability => capability.permissions)
const permission = (command: string) => `allow-${command.replaceAll("_", "-")}`

it("exposes remote computer and shutdown commands through the desktop permission boundary", () => {
  const handlers = readFileSync(resolve(native, "src/main.rs"), "utf8").split("tauri::generate_handler![")[1]?.split("])")[0] ?? ""
  const manifest = readFileSync(resolve(native, "build.rs"), "utf8").split(".commands(&[")[1]?.split("])")[0] ?? ""
  for (const command of [...shared, ...management]) {
    expect(handlers, command).toContain(`::${command},`)
    expect(manifest, command).toContain(`"${command}"`)
    expect(permissions("main"), command).toContain(permission(command))
  }
})

it("allows status remote VM actions without granting computer management", () => {
  for (const command of shared) expect(permissions("status"), command).toContain(permission(command))
  for (const command of management) expect(permissions("status"), command).not.toContain(permission(command))
})
