import type { ApplicationSource } from "@/features/application/model/application-source"

export const resourceFixtureModes = ["create-storage", "start-memory"] as const
export type ResourceFixtureMode = (typeof resourceFixtureModes)[number]

export function resourceFixtureModeFromSearch(search: string): ResourceFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("resource-notice")
  return resourceFixtureModes.find((mode) => mode === requested)
}

export function withResourceFixture(source: ApplicationSource, mode?: ResourceFixtureMode): ApplicationSource {
  if (mode === "create-storage") return { ...source, resourceNotice: { kind: "create-storage", sandbox: "sandbox", requiredGB: 18, availableGB: 11, volume: "the selected volume" } }
  if (mode === "start-memory") return { ...source, resourceNotice: { kind: "start-memory", sandbox: "dev", memoryGiB: 32 } }
  return source
}
