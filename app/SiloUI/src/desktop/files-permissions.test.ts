import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../../src-tauri")
const commands = ["list_workspace_directory"]
type Capability = { windows: string[]; permissions: Array<string | { identifier: string }> }
const capabilities = readdirSync(resolve(native, "capabilities")).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(resolve(native, "capabilities", name), "utf8")) as Capability)

function permissions(window: string) {
  return capabilities.filter((capability) => capability.windows.some((pattern) => pattern === window || pattern === "*"))
    .flatMap((capability) => capability.permissions.map((permission) => typeof permission === "string" ? permission : permission.identifier))
}

describe("Files desktop permission boundary", () => {
  // Mocked invokes cannot detect a command present in Rust but denied by Tauri.
  it("lets the main window reach every Files command through the native permission manifest", () => {
    const handlers = readFileSync(resolve(native, "src/main.rs"), "utf8").split("tauri::generate_handler![")[1]?.split("])")[0] ?? ""
    const manifest = readFileSync(resolve(native, "build.rs"), "utf8").split(".commands(&[")[1]?.split("])")[0] ?? ""
    const allowed = permissions("main")
    for (const command of commands) {
      expect(handlers).toContain(`files::${command},`)
      expect(manifest).toContain(`"${command}"`)
      expect(allowed).toContain(`allow-${command.replaceAll("_", "-")}`)
    }
  })

  it("grants read-only file browsing to the status panel", () => {
    const allowed = permissions("status")
    for (const command of commands) {
      expect(allowed).toContain(`allow-${command.replaceAll("_", "-")}`)
    }
  })
})
