import { expect, it } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { configurationFailureDiagnostic } from "./configuration-failure"

it("discloses only safe failure diagnostics from this attempt and computer", () => {
  const operation = structuredClone(applicationSourceForScenario("running", undefined, undefined, "computer-error").computerConfigurationOperation!)
  const event = { schemaVersion: 1 as const, type: "progress" as const, requestId: operation.id, phase: "computers", step: "setup-failed", computer: "scratch", safeForDisplay: true, message: "Retry setup.", diagnostic: "current output" }
  operation.progressEvents = [event,
    { ...event, requestId: "old", diagnostic: "old output" },
    { ...event, safeForDisplay: false, diagnostic: "private output" },
    { ...event, step: "setup-started", diagnostic: "unrelated output" },
    { ...event, computer: "other", diagnostic: "other computer output" },
  ]
  expect(configurationFailureDiagnostic(operation)).toBe("current output")
  expect(configurationFailureDiagnostic(operation, "scratch")).toBe("current output")
  expect(configurationFailureDiagnostic(operation, "missing")).toBeUndefined()
})
