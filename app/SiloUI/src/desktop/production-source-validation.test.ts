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

describe.each([
  ["local", parseApplicationSource],
  ["remote", parseRemoteApplicationSource],
] as const)("%s legacy preference validation", (_owner, parse) => {
  const source = applicationSourceForScenario("running")

  it.each([
    ["startupWorkspaceIds", {}],
    ["startupWorkspaceIds", [123]],
    ["terminalPath", 123],
    ["editorPath", { path: "/Applications/Editor.app" }],
    ["browserPath", "relative/path"],
    ["terminalUseSystemDefault", "false"],
    ["editorUseSystemDefault", 1],
    ["browserUseSystemDefault", null],
  ])("drops an invalid %s without losing other preferences", (field, value) => {
    const preferences = parse({ ...source, preferences: { ...source.preferences, [field]: value } }).preferences
    expect(Reflect.get(preferences, field)).toBeUndefined()
    expect(preferences.terminal).toBe(source.preferences.terminal)
    expect(() => new Set(preferences.startupWorkspaceIds)).not.toThrow()
  })

  it("retains valid optional preferences and fields from newer Silo versions", () => {
    const preferences = {
      ...source.preferences,
      startupWorkspaceIds: [source.workspaces[0].machine.id],
      terminalPath: "/Applications/Terminal.app", editorPath: null, browserPath: "/usr/bin/firefox",
      terminalUseSystemDefault: false, editorUseSystemDefault: true, browserUseSystemDefault: false,
      futurePreference: { enabled: true },
    }
    expect(parse({ ...source, preferences }).preferences).toEqual(preferences)
  })
})
