import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { computerMenuItems, type ComputerMenuItem } from "./computer-menu-items"

function handlers() {
  return { start: vi.fn(), confirm: vi.fn(), openTerminal: vi.fn(), chooseFolder: vi.fn(), openSite: vi.fn() }
}

function shape(items: ComputerMenuItem[]): unknown[] {
  return items.map((item) => item.kind === "separator" ? "---"
    : item.kind === "submenu" ? { [item.label]: shape(item.items), enabled: item.enabled }
      : item.kind === "copy" ? `copy ${item.value}`
        : `${item.label}${item.enabled ? "" : " (disabled)"}`)
}

describe("computer menu items shared by the native and preview menus", () => {
  it("offers confirmed Stop and Restart, open actions and each reachable site with its own address", () => {
    const source = applicationSourceForScenario("complete")
    const computer = { ...source.computers[0]!, ports: [
      { port: 8080, listening: true, configured: true, hostPort: 18080, scheme: "https" as const },
      { port: 3000, listening: true, configured: true, hostPort: 13000, scheme: "http" as const },
      { port: 5173, listening: false, configured: true, hostPort: 15173, scheme: "http" as const },
      { port: 9000, listening: true, configured: false, hostPort: 19000, scheme: "http" as const },
    ] }
    const actions = handlers()
    const items = computerMenuItems(computer, source, actions)
    expect(shape(items)).toEqual([
      "Stop…", "Restart…", "---", "Open in Terminal", "Open in Visual Studio Code…",
      { "Open in browser": ["Port 3000", "Port 8080", "---", "copy http://127.0.0.1:13000", "copy https://127.0.0.1:18080"], enabled: true },
    ])
    const find = (label: string, list = items) => list.find((item) => "label" in item && item.label === label)
    ;(find("Stop…") as Extract<ComputerMenuItem, { kind: "action" }>).run()
    expect(actions.confirm).toHaveBeenCalledWith("stop")
    const sites = (find("Open in browser") as Extract<ComputerMenuItem, { kind: "submenu" }>).items
    ;(find("Port 8080", sites) as Extract<ComputerMenuItem, { kind: "action" }>).run()
    expect(actions.openSite).toHaveBeenCalledWith(8080)
  })

  it("offers Start for a stopped computer and says when no site is active", () => {
    const source = applicationSourceForScenario("complete")
    const computer = { ...source.computers[0]!, state: "stopped" as const, ports: [] }
    expect(shape(computerMenuItems(computer, source, handlers()))).toEqual([
      "Start", "---", "Open in Terminal (disabled)", "Open in Visual Studio Code… (disabled)",
      { "Open in browser": ["No reachable ports (disabled)"], enabled: false },
    ])
  })

  it("disables lifecycle and open actions while the status is stale", () => {
    const source = applicationSourceForScenario("complete")
    const computer = { ...source.computers[0]!, freshness: "stale" as const }
    const items = shape(computerMenuItems(computer, source, handlers()))
    expect(items.slice(0, 5)).toEqual(["Stop… (disabled)", "Restart… (disabled)", "---", "Open in Terminal (disabled)", "Open in Visual Studio Code… (disabled)"])
  })
})
