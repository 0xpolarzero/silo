import { describe, expect, it } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { parseApplicationSource, parseRemoteApplicationSource } from "./production-source"

describe.each([
  ["local", parseApplicationSource],
  ["remote", parseRemoteApplicationSource],
] as const)("%s configuration operation validation", (_owner, parse) => {
  const source = applicationSourceForScenario("running", undefined, undefined, "workspace-error")
  const failed = source.sandboxConfigurationOperation

  it("retains a valid failed operation and its diagnostic", () => {
    expect(parse(source).sandboxConfigurationOperation).toEqual(failed)
  })

  it.each([
    ["failure without an error", { ...failed, status: "failed", error: null }],
    ["approval without a result", { ...failed, status: "awaiting-approval", result: null, error: null }],
    ["applying with an error", { ...failed, status: "applying" }],
    ["approval with an error", { ...failed, status: "awaiting-approval", result: { resumed: false, phase: "workspaces", requiresApproval: true, vmsStarted: false, message: "Approve setup." } }],
  ])("discards %s without losing its computer's state", (_description, operation) => {
    const parsed = parse({ ...source, sandboxConfigurationOperation: operation })
    expect(parsed.sandboxConfigurationOperation).toBeNull()
    expect(parsed.workspaces).toEqual(parse(source).workspaces)
  })

  it("retains the valid applying and approval variants", () => {
    const applying = { ...failed, status: "applying", result: null, error: null }
    const approval = { ...applying, status: "awaiting-approval", result: { resumed: false, phase: "workspaces", requiresApproval: true, vmsStarted: false, message: "Approve setup." } }
    for (const operation of [applying, approval]) {
      expect(parse({ ...source, sandboxConfigurationOperation: operation }).sandboxConfigurationOperation).toEqual(operation)
    }
  })
})
