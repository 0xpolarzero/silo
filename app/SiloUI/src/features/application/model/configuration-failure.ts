import type { SandboxConfigurationOperation } from "./application-source"

/** Setup diagnostics belong to the failed attempt and, for a row, its sandbox. */
export function configurationFailureDiagnostic(operation: SandboxConfigurationOperation, workspace?: string): string | undefined {
  const target = workspace ?? (operation.status === "failed" ? operation.error.workspace : undefined)
  return operation.progressEvents.findLast(event => event.safeForDisplay
    && event.requestId === operation.id
    && event.step === "setup-failed"
    && (!target || event.workspace === target))?.diagnostic
}
