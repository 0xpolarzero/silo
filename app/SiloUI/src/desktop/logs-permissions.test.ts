import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const native = resolve(import.meta.dirname, "../../src-tauri")
const commands = ["query_sandbox_logs", "export_workspace_logs", "cancel_log_export"]

it.each(commands)("allows the main window to invoke %s through the native boundary", command => {
  const manifest = readFileSync(resolve(native, "build.rs"), "utf8").split(".commands(&[")[1]?.split("])")[0] ?? ""
  expect(manifest).toContain(`"${command}"`)
  expect(readFileSync(resolve(native, "src/main.rs"), "utf8")).toContain(`::${command},`)
  const permission = `allow-${command.replaceAll("_", "-")}`
  const grants = readdirSync(resolve(native, "capabilities")).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(resolve(native, "capabilities", name), "utf8")) as { windows: string[]; permissions: string[] })
    .filter(capability => capability.permissions.includes(permission))
  expect(grants.flatMap(capability => capability.windows)).toEqual(["main"])
})
