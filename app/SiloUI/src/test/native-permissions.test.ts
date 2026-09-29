import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// One table-driven check that every command the frontend invokes is reachable:
// registered in `generate_handler!`, listed in the build.rs permission
// manifest, and granted by a capability. Commands only the status panel or the
// desktop shell call are granted by their own capability; the snapshot below
// pins those non-main grants. Mocked invokes in component tests cannot detect a
// command that Tauri denies.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = join(root, "src")
const native = join(root, "src-tauri")

// Commands the frontend calls that are intentionally not app commands.
const notAppCommands = new Map<string, string>([
  // Called only by the glass study fixture preview; registered by the native
  // preview build, never by the app (see command_permissions_tests.rs).
  ["set_preview_theme", "fixture preview only"],
])

// Known gaps tracked in the review ledger. Remove the entry with the fix; the
// test fails if a listed gap is already closed so the list cannot go stale.
const knownGaps = new Map<string, { missing: Array<"handler" | "manifest" | "capability">; ledger: string }>([
  // None at present: A-04 (reveal_backup_archive missing from build.rs) is
  // already fixed on main. Example: ["command", { missing: ["manifest"], ledger: "A-04" }]
])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// Only literal command names are checked; the few calls that pass a command
// variable are covered by the literal call sites that feed them.
function invokedCommands() {
  const commands = new Map<string, string[]>()
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(/\binvoke\s*(?:<[^(]*?>)?\s*\(\s*["']([a-z][a-z0-9_]*)["']/g)) {
      commands.set(match[1], [...(commands.get(match[1]) ?? []), relative(root, file)])
    }
  }
  return commands
}

function handlerCommands() {
  const text = readFileSync(join(native, "src/main.rs"), "utf8")
  const block = text.split("tauri::generate_handler![")[1]?.split("]")[0] ?? ""
  return new Set(block.split(",").map(path => path.replace(/\/\/.*$/gm, "").trim()).filter(Boolean).map(path => path.split("::").at(-1)!))
}

function manifestCommands() {
  const text = readFileSync(join(native, "build.rs"), "utf8")
  const block = text.split(".commands(&[")[1]?.split("]")[0] ?? ""
  return new Set([...block.matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1]))
}

type Capability = { identifier: string; windows?: string[]; webviews?: string[]; permissions: Array<string | { identifier: string }> }
const capabilities = readdirSync(join(native, "capabilities")).filter(name => name.endsWith(".json")).sort()
  .map(name => JSON.parse(readFileSync(join(native, "capabilities", name), "utf8")) as Capability)
const permissionIds = (capability: Capability) => capability.permissions.map(permission => typeof permission === "string" ? permission : permission.identifier)

const grantedPermissions = () => new Set(capabilities.flatMap(permissionIds))

describe("native command permissions", () => {
  const invoked = invokedCommands()
  const handlers = handlerCommands()
  const manifest = manifestCommands()
  const granted = grantedPermissions()

  it("extracts a plausible command set from source, main.rs and build.rs", () => {
    expect(invoked.size).toBeGreaterThan(50)
    expect(handlers.size).toBeGreaterThan(50)
    expect(manifest.size).toBeGreaterThan(50)
  })

  const rows = [...invoked.keys()].sort().filter(command => !notAppCommands.has(command))
  it.each(rows)("%s is handled, in the manifest, and granted", command => {
    const missing = [
      ...(handlers.has(command) ? [] : ["handler" as const]),
      ...(manifest.has(command) ? [] : ["manifest" as const]),
      ...(granted.has(`allow-${command.replaceAll("_", "-")}`) ? [] : ["capability" as const]),
    ]
    expect({ command, missing, callers: missing.length ? invoked.get(command) : [] })
      .toEqual({ command, missing: knownGaps.get(command)?.missing ?? [], callers: missing.length ? invoked.get(command) : [] })
  })

  it("keeps the allow-lists referring to commands the frontend still calls", () => {
    for (const command of [...notAppCommands.keys(), ...knownGaps.keys()]) expect(invoked.has(command)).toBe(true)
  })

  // What windows other than main may call is a security boundary; changing it
  // must be a deliberate snapshot update reviewed with the capability file.
  it("pins every non-main window grant", () => {
    const nonMain = capabilities
      .map(capability => ({
        identifier: capability.identifier,
        windows: (capability.windows ?? []).filter(window => window !== "main"),
        webviews: capability.webviews ?? [],
        permissions: permissionIds(capability).sort(),
      }))
      .filter(capability => capability.windows.length > 0 || capability.webviews.length > 0)
    expect(nonMain).toMatchSnapshot()
  })
})
