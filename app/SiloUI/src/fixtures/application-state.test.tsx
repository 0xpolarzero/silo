import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { computerTarget } from "@/features/application/model/connections"
import { applicationSourceForScenario } from "./application-scenarios"
import { useApplicationFixture } from "./application-state"

function checkpointSource() {
  const source = applicationSourceForScenario("complete")
  source.computers[1].state = "stopped"
  source.computers[1].checkpoints = [{ id: "c1234567890123456789012345678901", name: "Saved", createdAt: "2026-10-02T10:00:00Z", scope: "disk", reason: "manual" }]
  return source
}

describe("native checkpoint fixture outcomes", () => {
  it.each([false, true])("forks the selected owner's configuration into a pending VM (remote: %s)", async (remote) => {
    const source = checkpointSource()
    const selected = source.computers[1]
    if (remote) selected.device = { id: "office", computerId: "second-vm", name: "Office", address: "office.test", connected: true }
    const { result } = renderHook(() => useApplicationFixture(source))
    await act(async () => result.current.forkCheckpoint(computerTarget(selected), selected.checkpoints![0].id, "forked"))
    const child = result.current.source.computers.at(-1)!
    expect(child.configuration).toEqual({ ...selected.configuration, id: expect.any(String), name: "forked" })
    expect(child.configuration.id).not.toBe(selected.configuration.id)
    expect(child).toMatchObject({ state: "stopped", stateDetail: "Ready to start from checkpoint", checkpoints: [], logs: [], files: [], repositories: [], ports: [], githubRepositories: selected.githubRepositories, secretNames: selected.secretNames, pendingCheckpointRestore: { checkpointId: selected.checkpoints![0].id, sourceComputer: selected.configuration.name, state: "disk" } })
    expect(child.device?.id).toBe(selected.device?.id)
    if (remote) {
      expect(child.device?.computerId).not.toBe(selected.device?.computerId)
      expect(child.configuration.id).toBe(computerTarget(child))
    }
  })

  it.each(["running", "stopped"] as const)("restores a %s VM with a recovery point and pending reference", async (state) => {
    const source = checkpointSource()
    const selected = source.computers[1]
    selected.state = state
    selected.device = { id: "office", computerId: "second-vm", name: "Office", address: "office.test", connected: true }
    const { result } = renderHook(() => useApplicationFixture(source))
    await act(async () => result.current.restoreCheckpoint(computerTarget(selected), selected.checkpoints![0].id))
    const restored = result.current.source.computers[1]
    expect(restored).toMatchObject({ state: "stopped", stateDetail: "Ready to start from checkpoint", logs: [], files: [], repositories: [], ports: [], pendingCheckpointRestore: { checkpointId: selected.checkpoints![0].id, sourceComputer: selected.configuration.name, state: "disk" } })
    expect(restored.checkpoints).toEqual([expect.objectContaining({ name: "Before restore", reason: "before-restore", scope: state === "running" ? "full" : "disk" }), selected.checkpoints![0]])
    expect(result.current.source.computers[0]).toEqual(source.computers[0])
  })

  it("rejects missing checkpoint selections with native string errors and preserves state", async () => {
    const source = checkpointSource()
    const { result } = renderHook(() => useApplicationFixture(source))
    await expect(result.current.forkCheckpoint(source.computers[1].configuration.name, "missing", "forked")).rejects.toBe("The selected checkpoint no longer exists.")
    await expect(result.current.restoreCheckpoint(source.computers[1].configuration.name, "missing")).rejects.toBe("The selected checkpoint no longer exists.")
    expect(result.current.source.computers).toEqual(source.computers)
  })

  it("forks current state by recording a new source checkpoint first", async () => {
    const source = checkpointSource()
    const { result } = renderHook(() => useApplicationFixture(source))
    await act(async () => result.current.forkCheckpoint(source.computers[1].configuration.name, null, "forked"))
    const original = result.current.source.computers[1]
    expect(original.checkpoints).toHaveLength(2)
    expect(original.checkpoints![0]).toMatchObject({ name: "Fork point", scope: "disk", reason: "manual" })
    expect(result.current.source.computers.at(-1)?.pendingCheckpointRestore?.checkpointId).toBe(original.checkpoints![0].id)
  })

  it("preserves a pending fork's lineage and scope when forking current state", async () => {
    const source = checkpointSource()
    source.computers[1].pendingCheckpointRestore = { checkpointId: "c2222222222222222222222222222222", sourceComputer: "original", state: "full" }
    const { result } = renderHook(() => useApplicationFixture(source))
    await act(async () => result.current.forkCheckpoint(source.computers[1].configuration.name, null, "forked"))
    expect(result.current.source.computers[1].checkpoints).toEqual(source.computers[1].checkpoints)
    expect(result.current.source.computers.at(-1)?.pendingCheckpointRestore).toEqual(source.computers[1].pendingCheckpointRestore)
  })

  it("keeps a pending recovery point's native member separate from its public checkpoint ID", async () => {
    const source = checkpointSource()
    const selected = source.computers[1]
    selected.pendingCheckpointRestore = { checkpointId: "c2222222222222222222222222222222", sourceComputer: "original", state: "full" }
    const { result } = renderHook(() => useApplicationFixture(source))
    await act(async () => result.current.restoreCheckpoint(selected.configuration.name, selected.checkpoints![0].id))
    const recovery = result.current.source.computers[1].checkpoints![0]
    expect(recovery).toMatchObject({ reason: "before-restore", scope: "full" })
    expect(recovery.id).not.toBe(selected.pendingCheckpointRestore.checkpointId)
    await act(async () => result.current.forkCheckpoint(selected.configuration.name, recovery.id, "recovered"))
    expect(result.current.source.computers.at(-1)?.pendingCheckpointRestore).toEqual(selected.pendingCheckpointRestore)
  })

  it("rejects a duplicate name on the selected device without publishing a fork", async () => {
    const source = checkpointSource()
    const { result } = renderHook(() => useApplicationFixture(source))
    await expect(result.current.forkCheckpoint(source.computers[1].configuration.name, source.computers[1].checkpoints![0].id, source.computers[0].configuration.name)).rejects.toBe("The fork name is already in use or the workspace limit was reached.")
    expect(result.current.source.computers).toEqual(source.computers)
  })

  it("captures a named checkpoint on the selected remote VM, newest first", async () => {
    const source = checkpointSource()
    const selected = source.computers[1]
    selected.device = { id: "office", computerId: "second-vm", name: "Office", address: "office.test", connected: true }
    const { result } = renderHook(() => useApplicationFixture(source))
    await act(async () => result.current.createCheckpoint(computerTarget(selected), "  Saved again  "))
    expect(result.current.source.computers[1].checkpoints).toEqual([expect.objectContaining({ id: expect.stringMatching(/^c[0-9a-f]{31}$/), name: "Saved again", scope: "disk", reason: "manual" }), selected.checkpoints![0]])
    expect(result.current.source.computers[0]).toEqual(source.computers[0])
  })

  it.each(["", "x".repeat(81), "name\u0000"])("rejects invalid checkpoint labels with the native string error", async (name) => {
    const source = checkpointSource()
    const { result } = renderHook(() => useApplicationFixture(source))
    await expect(result.current.createCheckpoint(source.computers[1].configuration.name, name)).rejects.toBe("Checkpoint name must contain 1 to 80 printable characters.")
    expect(result.current.source.computers).toEqual(source.computers)
  })
})
