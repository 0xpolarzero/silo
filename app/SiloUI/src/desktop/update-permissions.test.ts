import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../../src-tauri")
const commands = ["get_update_state", "check_for_update", "download_update", "install_update", "set_update_automatic_checks", "open_update_release"]
type Capability = { windows: string[]; permissions: Array<string | { identifier: string }> }
const capabilities = readdirSync(resolve(native, "capabilities")).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(resolve(native, "capabilities", name), "utf8")) as Capability)
function permissions(window: string) {
  return capabilities.filter((capability) => capability.windows.some((pattern) => pattern === window || pattern === "*"))
    .flatMap((capability) => capability.permissions.map((permission) => typeof permission === "string" ? permission : permission.identifier))
}
it("lets the main window reach all host-owned update commands", () => {
  const handlers = readFileSync(resolve(native, "src/main.rs"), "utf8").split("tauri::generate_handler![")[1]?.split("])")[0] ?? ""
  const manifest = readFileSync(resolve(native, "build.rs"), "utf8").split(".commands(&[")[1]?.split("])")[0] ?? ""
  for (const command of commands) {
    expect(handlers).toContain(`updates::${command},`)
    expect(manifest).toContain(`"${command}"`)
    expect(permissions("main")).toContain(`allow-${command.replaceAll("_", "-")}`)
  }
})
it("does not grant updater control to the status window through shared permissions", () => {
  for (const command of commands) expect(permissions("status")).not.toContain(`allow-${command.replaceAll("_", "-")}`)
})
it("does not allow webviews to bypass host installation gates using plugin commands", () => {
  for (const capability of capabilities) {
    const allowed = capability.permissions.map((permission) => typeof permission === "string" ? permission : permission.identifier)
    expect(allowed.filter((permission) => permission.startsWith("updater:"))).toEqual([])
  }
})
