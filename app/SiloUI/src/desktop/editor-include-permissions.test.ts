import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const native = resolve(import.meta.dirname, "../../src-tauri")
const command = "read_editor_include_notice"

describe(`Editor connection notice permission boundary: ${command}`, () => {
  // Mocked bridge calls cannot catch a command denied by Tauri's native ACL.
  it("registers the handler and generates its command permission", () => {
    const handlers = readFileSync(resolve(native, "src/main.rs"), "utf8").split("tauri::generate_handler![")[1]?.split("])")[0] ?? ""
    const manifest = readFileSync(resolve(native, "build.rs"), "utf8").split(".commands(&[")[1]?.split("])")[0] ?? ""
    expect(handlers).toContain(`editor::${command},`)
    expect(manifest).toContain(`"${command}"`)
  })

  // The line names the user's home folder, so only the main window may read it.
  it("grants access only to the main window", () => {
    const permission = `allow-${command.replaceAll("_", "-")}`
    const grants = readdirSync(resolve(native, "capabilities")).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(resolve(native, "capabilities", name), "utf8")) as { windows: string[]; permissions: Array<string | { identifier: string }> })
      .filter(capability => capability.permissions.some(entry => (typeof entry === "string" ? entry : entry.identifier) === permission))
    expect(grants.flatMap(capability => capability.windows)).toEqual(["main"])
  })
})
