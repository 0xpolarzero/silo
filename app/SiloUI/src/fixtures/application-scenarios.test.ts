import { expect, it } from "vitest"
import { applicationSourceForScenario } from "./application-scenarios"

it.each(["running", "complete"] as const)("returns an independent %s source on every call", scenario => {
  const first = applicationSourceForScenario(scenario)
  const pristine = structuredClone(first)
  first.computers[0].configuration.name = "mutated"
  first.computers[0].repositories.push(first.computers[0].repositories[0])
  first.computers.pop()

  expect(applicationSourceForScenario(scenario)).toEqual(pristine)
})
