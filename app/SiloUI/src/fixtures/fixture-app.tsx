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
import { FixtureSelector } from "@/fixtures/fixture-selector"
import { activityFixtureModeFromSearch, activityFixtureStepCount } from "@/fixtures/application-activity"
import { githubStateFromSearch, onboardingScenarios, repositoryFixtures, scenarioFromSearch } from "@/fixtures/scenarios"
import { surfaceFromSearch } from "@/fixtures/surfaces"
import { StatusBarPreview } from "@/fixtures/status-bar-preview"
import { statusBarFixtureModeFromSearch } from "@/fixtures/status-bar-scenarios"
import type { StatusBarRoute } from "@/features/status-bar/status-bar-types"
import { useDesktopFixtures } from "./use-desktop-fixtures"

export function FixtureApp() {
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
  const statusBarMode = statusBarFixtureModeFromSearch(window.location.search)
  const [activityStep, setActivityStep] = useState(0)
  const fixtureSource = completedSetup ? applicationPreviewAfterSetup(completedSetup) : applicationSourceForScenario(scenario, githubState, workspaceMode, sandboxConfigurationMode, systemIssueMode, repositoryPushMode, activityMode, activityStep, githubManagementMode)
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
          source={onboardingScenarios[scenario]}
          initialGitHubConnectionState={githubState}
          repositoryOptions={repositoryFixtures}
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
      {<FixtureSelector statusBarMode={statusBarMode} backupMode={backupMode} surface={surface} scenario={scenario} githubState={githubState} workspaceMode={workspaceMode} sandboxConfigurationMode={sandboxConfigurationMode} systemIssueMode={systemIssueMode} repositoryPushMode={repositoryPushMode} githubManagementMode={githubManagementMode} activityMode={activityMode} />}
    </>
  )
}
