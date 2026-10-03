import { describe, expect, it } from "vitest"
import { fixtureLogPage, logIdentity, type LogQuery } from "@/features/application/model/logs"
import { applicationSourceForScenario } from "./application-scenarios"

function fixture(count = 401) {
  const workspace = applicationSourceForScenario("running").workspaces[0]
  workspace.logs = Array.from({ length: count }, (_, index) => ({ occurredAt: new Date(1700000000000 + index * 1000).toISOString(), line: `record ${index}` }))
  return { workspace, request: logIdentity(workspace) }
}

describe("native log page fixture behavior", () => {
  it.each([[0, 1], [1, 1], [201, 200], [5000, 200]])("clamps a requested limit of %i to %i", (limit, expected) => {
    const { workspace, request } = fixture()
    const page = fixtureLogPage(workspace, { ...request, limit })
    expect(page.entries).toHaveLength(expected)
    expect(page.nextCursor).toBe(String(expected))
  })

  it("keeps serialized entries within the native 1 MiB page budget", () => {
    const { workspace, request } = fixture(100)
    workspace.logs.forEach(log => { log.line = "x".repeat(64 * 1024) })
    const page = fixtureLogPage(workspace, request)
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.entries.length).toBeLessThan(100)
    expect(page.entries.reduce((bytes, entry) => bytes + new TextEncoder().encode(JSON.stringify(entry)).length, 0)).toBeLessThanOrEqual(1024 * 1024)
    expect(page.nextCursor).toBe(String(page.entries.length))
  })

  it("preserves native sandbox identity and owner names for remote logs", () => {
    const { workspace } = fixture(1)
    const remote = { ...workspace, machine: { ...workspace.machine, id: "silo-remote:office:vm-1" }, device: { id: "office", vmId: "vm-1", name: "Office", address: "office.test", connected: true } }
    expect(fixtureLogPage(remote, logIdentity(remote)).entries[0]).toMatchObject({ sandboxId: "vm-1", sandboxName: workspace.machine.name, deviceId: "office", deviceName: "Office", session: null })
  })

  it("treats the native all source as unfiltered", () => {
    const { workspace, request } = fixture()
    expect(fixtureLogPage(workspace, { ...request, source: "all" })).toEqual(fixtureLogPage(workspace, request))
  })

  it("returns the unfiltered 101-record context regardless of the requested page size", () => {
    const { workspace, request } = fixture()
    const page = fixtureLogPage(workspace, { ...request, aroundId: "200", limit: 1, query: "absent", source: "kernel" })
    expect(page.entries).toHaveLength(101)
    expect(page.entries[50].id).toBe("200")
    expect(page.totalMatches).toBe(401)
    expect(page.nextCursor).toBeNull()
  })

  it.each([
    [{ source: "invented" }, "Unknown log source."],
    [{ source: "" }, "Unknown log source."],
    [{ query: "x".repeat(4097) }, "Search text is too long."],
    [{ since: "not-a-date" }, "Invalid log timestamp."],
    [{ since: "2026-10-02" }, "Invalid log timestamp."],
    [{ since: "2026-10-02T12:00:00Z", until: "2026-10-02T11:00:00Z" }, "The log time range is reversed."],
    [{ aroundId: "expired" }, "The selected log record expired. Refresh the log search."],
  ] as [Partial<LogQuery>, string][])("returns the native structured query failure: %j", (query, message) => {
    const { workspace, request } = fixture()
    let cause: unknown
    try { fixtureLogPage(workspace, { ...request, ...query }) } catch (error) { cause = error }
    expect(cause).toEqual({ code: "internal", message })
  })
})
