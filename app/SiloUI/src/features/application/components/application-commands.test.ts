import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { workspaceTarget } from "../model/remote-computers"
import { applicationCommands } from "./application-commands"

function remoteRunningSource() {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.runtimeRepair = null
  source.sandboxConfigurationOperation = null
  source.activities = []
  const local = source.workspaces.find(item => item.machine.kind === "vm" && !item.computer)!
  const remote = structuredClone(local)
  remote.machine = { ...remote.machine, id: `${local.machine.id}-office` }
  remote.computer = { id: "office", vmId: "vm-office", name: "Office", address: "office.test", connected: true }
  for (const workspace of [local, remote]) {
    workspace.state = "running"
    workspace.freshness = "fresh"
    workspace.attention = undefined
    workspace.lifecycleAction = undefined
  }
  source.workspaces.push(remote)
  return { source, local, remote }
}

it("addresses a remote sandbox by its computer target and names the computer", () => {
  const { source, remote } = remoteRunningSource()
  const actions = { openTerminal: vi.fn(), openEditor: vi.fn(), startWorkspace: vi.fn(), stopWorkspace: vi.fn(), restartWorkspace: vi.fn() } as unknown as ApplicationActions
  const commands = applicationCommands(source, actions, vi.fn())
  const target = workspaceTarget(remote)

  const terminal = commands.find(command => command.id === `${remote.machine.id}:terminal`)!
  expect(terminal.label).toBe(`Open ${remote.machine.name} on Office in ${source.preferences.terminal}`)
  expect(terminal.keywords).toContain("Office")
  terminal.run()
  expect(actions.openTerminal).toHaveBeenCalledWith(target)

  commands.find(command => command.id === `${remote.machine.id}:editor`)!.run()
  expect(actions.openEditor).toHaveBeenCalledWith(target)
})
