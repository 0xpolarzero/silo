import { expect, it } from "vitest"
import { applicationSourceForScenario } from "./application-scenarios"

it.each(["running", "complete"] as const)("returns an independent %s source on every call", scenario => {
  const first = applicationSourceForScenario(scenario)
  const pristine = structuredClone(first)
  first.workspaces[0].machine.name = "mutated"
  first.workspaces[0].repositories.push(first.workspaces[0].repositories[0])
  first.workspaces.pop()

  expect(applicationSourceForScenario(scenario)).toEqual(pristine)
})
