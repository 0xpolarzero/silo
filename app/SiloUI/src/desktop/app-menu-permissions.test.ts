import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../../src-tauri")
it("exposes native menu reveal and availability only to the main window", () => {
  const capabilities = readdirSync(resolve(native, "capabilities")).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(resolve(native, "capabilities", name), "utf8")) as { windows: string[]; permissions: (string | { identifier: string })[] })
  for (const command of ["show_app_menu", "set_app_menu_state"]) {
    expect(readFileSync(resolve(native, "build.rs"), "utf8")).toContain(`"${command}"`)
    expect(readFileSync(resolve(native, "src/main.rs"), "utf8")).toContain(`app_menu::${command},`)
    const permission = `allow-${command.replaceAll("_", "-")}`
    const grants = capabilities.filter(cap => cap.permissions.some(p => (typeof p === "string" ? p : p.identifier) === permission))
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.flatMap(cap => cap.windows)).toEqual(["main"])
  }
})
