import type { ApplicationSource, ApplicationComputer } from "@/features/application/model/application-source"

export const statusBarFixtureModes = ["stale", "empty", "long-list"] as const
export type StatusBarFixtureMode = (typeof statusBarFixtureModes)[number]

export function statusBarFixtureModeFromSearch(search: string): StatusBarFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("status-bar")
  return statusBarFixtureModes.find((mode) => mode === requested)
}

export function statusBarSourceForFixture(source: ApplicationSource, mode?: StatusBarFixtureMode): ApplicationSource {
  if (mode === "empty") return { ...source, computers: [] }
  if (mode === "stale") return { ...source, computers: source.computers.map((computer) => ({ ...computer, freshness: "stale" })) }
  if (mode === "long-list" && source.computers.length) {
    const names = ["api", "design-system", "docs", "integration-tests", "release", "services", "website"]
    const template = source.computers[0]
    return {
      ...source,
      computers: [
        ...source.computers,
        ...names.map((name, index): ApplicationComputer => ({
          ...template,
          configuration: { ...template.configuration, id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`, name },
          state: "stopped",
          stateDetail: "Stopped",
          attention: undefined,
          freshness: "fresh",
          ports: [],
          repositories: [],
          files: [],
          logs: [],
          githubRepositories: [],
          secretNames: [],
        })),
      ],
    }
  }
  return source
}

