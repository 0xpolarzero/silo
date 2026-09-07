import { useEffect, useRef, useState } from "react"

import { OnboardingApp, type OnboardingAppProps } from "@/features/onboarding/onboarding-app"
import type { GitHubConnectionState, OnboardingActions } from "@/features/onboarding/model/onboarding-source"
import { onboardingScenarios } from "./scenarios"

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

  useEffect(() => () => window.clearTimeout(connectTimer.current), [])

  return <OnboardingApp
    {...props}
    source={source}
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
      repairRuntime: () => {
        actions?.repairRuntime?.()
        setSource(onboardingScenarios.running)
      },
      retryWorkspaceSetup: () => {
        actions?.retryWorkspaceSetup?.()
        setSource(onboardingScenarios.running)
      },
      finishSetup: (request) => {
        actions?.finishSetup?.(request)
        setCompleted(true)
      },
    }}
  />
}
