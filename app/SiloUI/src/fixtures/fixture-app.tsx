import { useEffect, useState } from "react"

import { ApplicationPreview } from "./application-preview"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { OnboardingPreview } from "./onboarding-preview"
import type { OnboardingCompletionRequest } from "@/features/onboarding/model/onboarding-source"
import { applicationPreviewAfterSetup } from "@/fixtures/onboarding-handoff"
import {
  applicationSourceForScenario,
  githubManagementFixtureModeFromSearch,
  repositoryPushFixtureModeFromSearch,
  sandboxConfigurationFixtureModeFromSearch,
  systemIssueFixtureModeFromSearch,
  workspaceFixtureModeFromSearch,
} from "@/fixtures/application-scenarios"
import { backupFixtureModeFromSearch } from "@/fixtures/application-backup"
import { activityFixtureModeFromSearch, activityFixtureStepCount } from "@/fixtures/application-activity"
import { githubStateFromSearch, onboardingScenarios, repositoryFixtures, scenarioFromSearch } from "@/fixtures/scenarios"
import { surfaceFromSearch } from "@/fixtures/surfaces"
import { StatusBarPreview } from "@/fixtures/status-bar-preview"
import { statusBarFixtureModeFromSearch } from "@/fixtures/status-bar-scenarios"
import type { StatusBarRoute } from "@/features/status-bar/status-bar-types"
import { useDesktopFixtures } from "./use-desktop-fixtures"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { settingsForFixture } from "./settings"
import type { DependencyRuntime } from "@/desktop/dependencies"
import { resourceFixtureModeFromSearch, withResourceFixture } from "./application-resources"

export function FixtureApp({ nativeOnboardingComplete = false, nativeDependencies = null, nativeOperations = false }: { nativeOnboardingComplete?: boolean; nativeDependencies?: DependencyRuntime | null; nativeOperations?: boolean }) {
  const source = applicationSourceForScenario(scenarioFromSearch(window.location.search))
  return <SettingsProvider initialSettings={settingsForFixture(source)}><FixtureAppContent nativeOnboardingComplete={nativeOnboardingComplete} nativeDependencies={nativeDependencies} nativeOperations={nativeOperations} /></SettingsProvider>
}

function FixtureAppContent({ nativeOnboardingComplete, nativeDependencies, nativeOperations }: { nativeOnboardingComplete: boolean; nativeDependencies: DependencyRuntime | null; nativeOperations: boolean }) {
  const [surface, setSurface] = useState(() => surfaceFromSearch(window.location.search))
  const [completedSetup, setCompletedSetup] = useState<OnboardingCompletionRequest | null>(null)
  const [statusBarHandoff, setStatusBarHandoff] = useState<{ source: ApplicationSource; route?: StatusBarRoute } | null>(null)
  const scenario = scenarioFromSearch(window.location.search)
  const githubState = githubStateFromSearch(window.location.search)
  const workspaceMode = workspaceFixtureModeFromSearch(window.location.search)
  const sandboxConfigurationMode = sandboxConfigurationFixtureModeFromSearch(window.location.search)
  const systemIssueMode = systemIssueFixtureModeFromSearch(window.location.search)
  const repositoryPushMode = repositoryPushFixtureModeFromSearch(window.location.search)
  const githubManagementMode = githubManagementFixtureModeFromSearch(window.location.search)
  const activityMode = activityFixtureModeFromSearch(window.location.search)
  const backupMode = backupFixtureModeFromSearch(window.location.search)
  const resourceMode = resourceFixtureModeFromSearch(window.location.search)
  const statusBarMode = statusBarFixtureModeFromSearch(window.location.search)
  const [activityStep, setActivityStep] = useState(0)
  const [dependencyFixtureRecovered, setDependencyFixtureRecovered] = useState(false)
  const fixtureSource = withResourceFixture(completedSetup ? applicationPreviewAfterSetup(completedSetup) : applicationSourceForScenario(scenario, githubState, workspaceMode, sandboxConfigurationMode, systemIssueMode, repositoryPushMode, activityMode, activityStep, githubManagementMode), resourceMode)
  useDesktopFixtures({ source: fixtureSource, mode: statusBarMode },
    (source) => setStatusBarHandoff((current) => ({ source, route: current?.route })),
    (route) => {
      setStatusBarHandoff((current) => ({ source: current?.source ?? fixtureSource, route }))
      const url = new URL(window.location.href)
      url.searchParams.set("view", "app")
      window.history.replaceState(null, "", url)
      setSurface("app")
    },
  )

  useEffect(() => {
    const stepCount = activityFixtureStepCount(activityMode)
    if (stepCount <= 1) return
    const timer = window.setInterval(() => {
      setActivityStep((current) => {
        if (current >= stepCount - 1) {
          window.clearInterval(timer)
          return current
        }
        return current + 1
      })
    }, 1_600)
    return () => window.clearInterval(timer)
  }, [activityMode])
  return (
    <>
      {surface === "app" ? (
        <ApplicationPreview
          key={`${scenario}:${githubState ?? "source"}:${workspaceMode ?? "source"}:${sandboxConfigurationMode ?? "source"}:${systemIssueMode ?? "source"}:${repositoryPushMode ?? "source"}:${activityMode ?? "source"}:${githubManagementMode ?? "source"}`}
          backupPreviewMode={backupMode}
          initialRoute={statusBarHandoff?.route}
          source={statusBarHandoff?.source ?? fixtureSource}
          nativeOperations={nativeOperations}
        />
      ) : surface === "status-bar" ? (
        <StatusBarPreview
          fixtureKey={`${scenario}:${githubState ?? "source"}:${workspaceMode ?? "source"}:${sandboxConfigurationMode ?? "source"}:${systemIssueMode ?? "source"}:${repositoryPushMode ?? "source"}:${activityMode ?? "source"}:${githubManagementMode ?? "source"}`}
          source={applicationSourceForScenario(scenario, githubState, workspaceMode, sandboxConfigurationMode, systemIssueMode, repositoryPushMode, activityMode, activityStep, githubManagementMode)}
          mode={statusBarMode}
          onOpenSilo={(snapshot, route) => {
            setStatusBarHandoff({ source: snapshot, route })
            const url = new URL(window.location.href)
            url.searchParams.set("view", "app")
            window.history.replaceState(null, "", url)
            setSurface("app")
          }}
        />
      ) : (
        <OnboardingPreview
          key={`${scenario}:${githubState ?? "source"}`}
          source={nativeDependencies ? {
            ...onboardingScenarios[scenarioFromSearch(window.location.search, "complete")],
            preflightChecks: nativeDependencies.checks,
          } : dependencyFixtureRecovered ? {
            ...onboardingScenarios[scenarioFromSearch(window.location.search, "complete")],
            preflightChecks: onboardingScenarios.complete.preflightChecks,
          } : onboardingScenarios[scenarioFromSearch(window.location.search, "complete")]}
          onRetryDependencies={nativeDependencies?.retry ?? (scenario === "dependency-failure" ? () => setDependencyFixtureRecovered(true) : undefined)}
          initialGitHubConnectionState={githubState}
          repositoryOptions={repositoryFixtures}
          initialCompleted={nativeOnboardingComplete}
          onOpenApp={() => {
            const url = new URL(window.location.href)
            url.searchParams.set("view", "app")
            window.history.replaceState(null, "", url)
            setSurface("app")
          }}
          actions={{
            finishSetup: setCompletedSetup,
          }}
        />
      )}
    </>
  )
}
