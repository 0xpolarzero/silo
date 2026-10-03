import { expect, it } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationSource, ApplicationWorkspace } from "./application-source"
import { workspaceAvailability } from "./workspace-availability"

function scenario(change: (workspace: ApplicationWorkspace, source: ApplicationSource) => void = () => {}) {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.runtimeRepair = null
  source.sandboxConfigurationOperation = null
  source.activities = []
  const workspace = source.workspaces.find(({ machine }) => machine.name === "dev")!
  Object.assign(workspace, { state: "running", freshness: "fresh", attention: undefined, lifecycleAction: undefined, checkpointOperation: null })
  change(workspace, source)
  return workspaceAvailability(workspace, source)
}

it("allows opening, stopping and restarting a running sandbox", () => {
  expect(scenario()).toMatchObject({ busy: false, canOpen: true, canStart: false, canStop: true, canRestart: true })
})

it("offers Start and Restart, but not Open, for a crashed sandbox with its error", () => {
  const availability = scenario((workspace) => {
    workspace.state = "failed"
    workspace.attention = { level: "error", message: "The sandbox runtime crashed. Restart it to retry." }
  })
  expect(availability).toMatchObject({ canOpen: false, canStart: true, canStop: false, canRestart: true })
  expect(availability.reasons.open).toBe("The sandbox runtime crashed. Restart it to retry.")
})

it("keeps Stop available for a running sandbox with an error notice", () => {
  const availability = scenario((workspace) => { workspace.attention = { level: "error", message: "GitHub access could not be applied." } })
  expect(availability).toMatchObject({ canOpen: false, canStop: true, canRestart: true })
})

it.each([
  ["a lifecycle action runs", (workspace: ApplicationWorkspace) => { workspace.lifecycleAction = "stop" }, "dev is stopping."],
  ["the VM is starting", (workspace: ApplicationWorkspace) => { workspace.state = "starting" }, "Wait for dev to finish starting."],
  ["a checkpoint operation runs", (workspace: ApplicationWorkspace) => { workspace.checkpointOperation = { kind: "capture", status: "running", stage: "Saving" } }, "Wait for the checkpoint to finish."],
  ["its device refreshes", (workspace: ApplicationWorkspace) => { workspace.device = { id: "office", vmId: "vm", name: "Office", address: "office.test", connected: true, busy: true } }, "Office is updating. Wait before changing this sandbox."],
  ["its device is offline", (workspace: ApplicationWorkspace) => { workspace.device = { id: "office", vmId: "vm", name: "Office", address: "office.test", connected: false }; workspace.freshness = "stale" }, "Office is offline. Reconnect it to manage this sandbox."],
  ["its status is stale", (workspace: ApplicationWorkspace) => { workspace.freshness = "stale" }, "Silo could not refresh this sandbox’s status."],
  ["the runtime needs repair", (_: ApplicationWorkspace, source: ApplicationSource) => { source.runtimeRepair = { status: "unavailable", checking: false, reason: "Missing", recovery: "" } }, "Resolve the system issue first."],
  ["sandbox changes apply", (_: ApplicationWorkspace, source: ApplicationSource) => { source.sandboxConfigurationOperation = { id: "x", status: "applying", candidate: { schemaVersion: 1, machines: [] }, progressEvents: [], result: null, error: null } }, "Wait for sandbox changes to finish."],
] as const)("disables every control with one reason while %s", (_, change, reason) => {
  const availability = scenario(change)
  expect(availability).toMatchObject({ canOpen: false, canStart: false, canStop: false, canRestart: false })
  expect(availability.reasons).toEqual({ open: reason, start: reason, stop: reason, restart: reason })
})

it("explains that a stopped sandbox must be started before opening it", () => {
  const availability = scenario((workspace) => { workspace.state = "stopped" })
  expect(availability).toMatchObject({ canOpen: false, canStart: true, canStop: false, canRestart: false })
  expect(availability.reasons.open).toBe("Start dev to open it.")
})
