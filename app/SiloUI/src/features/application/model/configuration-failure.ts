import type { ComputerConfigurationOperation } from "./application-source"

/** Setup diagnostics belong to the failed attempt and, for a row, its computer. */
export function configurationFailureDiagnostic(operation: ComputerConfigurationOperation, computer?: string): string | undefined {
  const target = computer ?? (operation.status === "failed" ? operation.error.computer : undefined)
  return operation.progressEvents.findLast(event => event.safeForDisplay
    && event.requestId === operation.id
    && event.step === "setup-failed"
    && (!target || event.computer === target))?.diagnostic
}
