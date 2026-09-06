import type { ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"

export const statusBarFixtureModes = ["stale", "empty", "long-list"] as const
export type StatusBarFixtureMode = (typeof statusBarFixtureModes)[number]

export function statusBarFixtureModeFromSearch(search: string): StatusBarFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("status-bar")
  return statusBarFixtureModes.find((mode) => mode === requested)
}

export function statusBarSourceForFixture(source: ApplicationSource, mode?: StatusBarFixtureMode): ApplicationSource {
  if (mode === "empty") return { ...source, workspaces: [] }
  if (mode === "stale") return { ...source, workspaces: source.workspaces.map((workspace) => ({ ...workspace, freshness: "stale" })) }
  if (mode === "long-list" && source.workspaces.length) {
    const names = ["api", "design-system", "docs", "integration-tests", "release", "services", "website"]
    const template = source.workspaces[0]
    return {
      ...source,
      workspaces: [
        ...source.workspaces,
        ...names.map((name, index): ApplicationWorkspace => ({
          ...template,
          machine: { ...template.machine, id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`, name },
          host: `${name}.silo.test`,
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

