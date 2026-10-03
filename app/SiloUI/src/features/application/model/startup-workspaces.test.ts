import { expect, it } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { defaultStartupWorkspaceIds, startupWorkspaceCandidates } from "./startup-workspaces"

const office = { id: "office", name: "Office Mac", address: "office.local", connected: true, vmId: "remote-dev" }

it("never picks a sandbox on another device as the default startup sandbox", () => {
  const [dev, playgrounds, personal] = structuredClone(applicationSourceForScenario("running").workspaces)
  const remoteDev = { ...dev, machine: { ...dev.machine, id: "remote-dev" }, device: office }
  expect(defaultStartupWorkspaceIds([remoteDev, playgrounds, dev, personal])).toEqual([dev.machine.id])
  expect(defaultStartupWorkspaceIds([remoteDev, playgrounds, personal])).toEqual([playgrounds.machine.id])
  expect(defaultStartupWorkspaceIds([remoteDev])).toEqual([])
  expect(startupWorkspaceCandidates([remoteDev, playgrounds]).map(({ machine }) => machine.id)).toEqual([playgrounds.machine.id])
})

it("excludes legacy SSH entries from the launch selection (D-20)", () => {
  const [dev, , personal] = structuredClone(applicationSourceForScenario("running").workspaces)
  const ssh = { ...dev, machine: { kind: "ssh" as const, id: "ssh-id", name: "dev", host: "example.test", user: "me", port: 22 } }
  expect(startupWorkspaceCandidates([ssh, personal])).toEqual([personal])
  expect(defaultStartupWorkspaceIds([ssh, personal])).toEqual([personal.machine.id])
})
