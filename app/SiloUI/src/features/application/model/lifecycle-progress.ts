/** Where a Start is, as reported by the backend while the computer's operation is held. */
export type LifecycleStep = "boot" | "network" | "account"

export const lifecycleSteps: readonly LifecycleStep[] = ["boot", "network", "account"]

const stepText: Record<LifecycleStep, string> = {
  boot: "Starting the computer",
  network: "Connecting the network",
  account: "Checking the computer account",
}

/** The one-line step text and bar fraction of a Start; before the first report it is the boot. */
export function startStepProgress(step: LifecycleStep | undefined): { step: string; progress: number } {
  const current = step ?? "boot"
  return { step: stepText[current], progress: (lifecycleSteps.indexOf(current) + 0.5) / lifecycleSteps.length }
}

export function isLifecycleStep(value: unknown): value is LifecycleStep {
  return typeof value === "string" && (lifecycleSteps as readonly string[]).includes(value)
}
