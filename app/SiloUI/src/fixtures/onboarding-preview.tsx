import { useEffect, useRef, useState } from "react"

import { OnboardingApp, type OnboardingAppProps } from "@/features/onboarding/onboarding-app"
import type { GitHubConnectionState, OnboardingActions } from "@/features/onboarding/model/onboarding-source"
import { onboardingScenarios } from "./scenarios"
import { ApplicationCatalogProvider } from "@/features/preferences/application-catalog"
import { fixtureApplicationCatalog } from "./application-catalog"
import { useSettings } from "@/features/preferences/settings-store"
import { SystemIntegrationProvider } from "@/features/preferences/system-integrations-store"
import { createFixtureSystemIntegrationStore } from "./system-integrations"

interface OnboardingPreviewProps extends Omit<OnboardingAppProps, "actions" | "githubConnectionState" | "completed"> {
  actions?: Partial<OnboardingActions>
  initialGitHubConnectionState?: GitHubConnectionState
  initialCompleted?: boolean
}

export function OnboardingPreview({ source: initialSource, actions, initialGitHubConnectionState, initialCompleted = false, ...props }: OnboardingPreviewProps) {
  const [source, setSource] = useState(initialSource)
  const [completed, setCompleted] = useState(initialCompleted)
  const [githubConnectionState, setGitHubConnectionState] = useState<GitHubConnectionState>(
    initialGitHubConnectionState ?? (source.githubPolicies.some(({ repositories }) => repositories.length > 0) ? "connected" : "disconnected"),
  )
  const connectTimer = useRef<number | undefined>(undefined)
  const { store } = useSettings()
  const [systemIntegrations] = useState(() => createFixtureSystemIntegrationStore(store))

  useEffect(() => () => window.clearTimeout(connectTimer.current), [])

  return <ApplicationCatalogProvider initialCatalog={fixtureApplicationCatalog}><SystemIntegrationProvider store={systemIntegrations}><OnboardingApp
    {...props}
    source={{ ...source, preflightChecks: initialSource.preflightChecks }}
    completed={completed}
    presentationOnlyCompleted={initialCompleted}
    githubConnectionState={githubConnectionState}
    actions={{
      connectGitHub: () => {
        actions?.connectGitHub?.()
        window.clearTimeout(connectTimer.current)
        setGitHubConnectionState("connecting")
        connectTimer.current = window.setTimeout(() => setGitHubConnectionState("connected"), 700)
      },
      saveMachineConfiguration: (request) => {
        actions?.saveMachineConfiguration?.(request)
        setSource((current) => ({ ...current, machineConfigurations: request.machines }))
      },
      retryWorkspaceSetup: () => {
        actions?.retryWorkspaceSetup?.()
        setSource((current) => ({
          ...onboardingScenarios.running,
          preflightChecks: current.preflightChecks,
        }))
      },
      finishSetup: (request) => {
        actions?.finishSetup?.(request)
        setCompleted(true)
      },
    }}
  /></SystemIntegrationProvider></ApplicationCatalogProvider>
}
