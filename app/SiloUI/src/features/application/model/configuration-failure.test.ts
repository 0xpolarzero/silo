import { expect, it } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { configurationFailureDiagnostic } from "./configuration-failure"

it("discloses only safe failure diagnostics from this attempt and sandbox", () => {
  const operation = structuredClone(applicationSourceForScenario("running", undefined, undefined, "workspace-error").sandboxConfigurationOperation!)
  const event = { schemaVersion: 1 as const, type: "progress" as const, requestId: operation.id, phase: "workspaces", step: "setup-failed", workspace: "scratch", safeForDisplay: true, message: "Retry setup.", diagnostic: "current output" }
  operation.progressEvents = [event,
    { ...event, requestId: "old", diagnostic: "old output" },
    { ...event, safeForDisplay: false, diagnostic: "private output" },
    { ...event, step: "setup-started", diagnostic: "unrelated output" },
    { ...event, workspace: "other", diagnostic: "other sandbox output" },
  ]
  expect(configurationFailureDiagnostic(operation)).toBe("current output")
  expect(configurationFailureDiagnostic(operation, "scratch")).toBe("current output")
  expect(configurationFailureDiagnostic(operation, "missing")).toBeUndefined()
})
