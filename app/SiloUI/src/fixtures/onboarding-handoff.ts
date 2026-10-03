import type { ApplicationSource } from "@/features/application/model/application-source"
import type { OnboardingCompletionRequest } from "@/features/onboarding/model/onboarding-source"
import { applicationSourceForScenario } from "./application-scenarios"

// The web preview carries setup choices into its application fixture. Native
// completion and live computer state remain the responsibility of the provider.
export function applicationPreviewAfterSetup(request: OnboardingCompletionRequest): ApplicationSource {
  const base = applicationSourceForScenario("complete", request.github.connectionState)
  return {
    ...base,
    computers: request.computerConfiguration.configurations.map((configuration) => ({
      configuration: { ...configuration },
      purpose: "Local computer",
      state: "stopped",
      stateDetail: "Ready",
      freshness: "fresh",
      repositories: [],
      files: [],
      ports: [],
      logs: [],
      githubRepositories: request.github.computers.find(({ computer }) => computer === configuration.name)?.repositories.map(({ repository }) => repository) ?? [],
      secretNames: [],
    })),
    activities: [],
    secrets: [],
    backup: { lastArchive: "", completedLabel: "", compressedSize: "", destination: "" },
    runtimeRepair: null,
    computerConfigurationOperation: null,
    repositoryPushOperations: [],
    preferences: { ...base.preferences, ...request.applications },
    github: {
      ...base.github,
      accessEnabled: request.github.connectionState === "connected",
      computers: request.github.computers.map(({ computer, identity, repositories }) => ({
        computer, identity: { ...identity }, repositories: repositories.map((repository) => ({ ...repository })),
      })),
      computerOperations: [],
    },
  }
}
