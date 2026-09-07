import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"

import { TabsContent } from "@/components/ui/tabs"
import { SetupComplete } from "@/features/onboarding/components/setup-complete"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { OnboardingShell } from "@/features/onboarding/components/onboarding-shell"
import type {
  GitHubConnectionState,
  OnboardingActions,
  OnboardingSource,
  WorkspaceGitIdentity,
  WorkspaceRepositorySelection,
} from "@/features/onboarding/model/onboarding-source"
import { onboardingSteps, projectOnboarding, type OnboardingStep, type WorkspaceView } from "@/features/onboarding/model/onboarding-state"
import { configurationRequest } from "@/features/onboarding/model/machine-configuration"
import { DependenciesStep } from "@/features/onboarding/steps/dependencies-step"
import { GitHubStep } from "@/features/onboarding/steps/github-step"
import { ReviewStep } from "@/features/onboarding/steps/review-step"
import { WorkspacesStep } from "@/features/onboarding/steps/workspaces-step"
import type { OnboardingDraft } from "@/features/onboarding/model/onboarding-draft"
import { useSettings } from "@/features/preferences/settings-store"
import { applicationPreferenceChanges } from "@/features/preferences/model/application-preferences"

export interface OnboardingAppProps {
  source: OnboardingSource
  actions: OnboardingActions
  githubConnectionState: GitHubConnectionState
  completed: boolean
  presentationOnlyCompleted?: boolean
  repositoryOptions?: readonly string[]
  onOpenApp?: () => void
}

function OnboardingPanel({ step, activeStep, children }: { step: OnboardingStep; activeStep: OnboardingStep; children: ReactNode }) {
  const active = step === activeStep
  // Retain layout as well as state: display:none restarts disclosure animations
  // and can clamp the panel's scroll offset when the step becomes visible again.
  return <TabsContent
    forceMount
    value={step}
    aria-hidden={!active}
    inert={!active}
    style={{ visibility: active ? "visible" : "hidden" }}
    className="absolute inset-0 mt-0 flex h-full min-h-0 flex-col overflow-y-auto outline-none"
  >
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-5 sm:px-6 sm:py-6">{children}</div>
  </TabsContent>
}

function repositoryKey(repository: string): string {
  return repository.toLowerCase()
}

function uniqueRepositoryOptions(repositories: readonly string[]): string[] {
  const seen = new Set<string>()
  return repositories.filter((repository) => {
    const key = repositoryKey(repository)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueWorkspaceSelections(selections: readonly WorkspaceRepositorySelection[]): WorkspaceRepositorySelection[] {
  const seen = new Set<string>()
  return selections.filter(({ repository }) => {
    const key = repositoryKey(repository)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function initialWorkspaceSelections(source: OnboardingSource): Record<string, WorkspaceRepositorySelection[]> {
  return Object.fromEntries(source.machineConfigurations.map(({ name }) => {
    const repositories = source.githubPolicies
      .filter(({ workspace }) => workspace === name)
      .flatMap(({ repositories: policyRepositories }) => policyRepositories)
    return [name, uniqueWorkspaceSelections(repositories.map((repository) => ({
      repository: repository.fullName,
      allowPushes: repository.mode === "read-write",
    })))]
  }))
}

function initialWorkspaceIdentities(source: OnboardingSource): Record<string, WorkspaceGitIdentity> {
  const { name = "", email = "" } = source.currentHostGitIdentity ?? {}
  return Object.fromEntries(source.machineConfigurations.map((workspace) => [
    workspace.name,
    { name, email, apply: true },
  ]))
}

function gitIdentityLabel(identity: WorkspaceGitIdentity): string {
  return `${identity.name || "No name"} <${identity.email || "No email"}>`
}

function workspaceIdentitySummary(
  identities: Record<string, WorkspaceGitIdentity>,
  workspaceNames: readonly string[],
): string {
  const appliedGroups = new Map<string, { identity: WorkspaceGitIdentity; workspaces: string[] }>()
  const notApplied: string[] = []

  for (const workspace of workspaceNames) {
    const identity = identities[workspace]
    if (!identity?.apply) {
      notApplied.push(workspace)
      continue
    }
    const key = JSON.stringify([identity.name, identity.email])
    const group = appliedGroups.get(key)
    if (group) group.workspaces.push(workspace)
    else appliedGroups.set(key, { identity, workspaces: [workspace] })
  }

  const summaries = [...appliedGroups.values()].map(({ identity, workspaces }) => {
    const target = workspaces.length === workspaceNames.length
      ? `all ${workspaceNames.length} sandboxes`
      : workspaces.join(", ")
    return `${gitIdentityLabel(identity)} → ${target}`
  })
  if (notApplied.length > 0) {
    summaries.push(`not applied → ${notApplied.join(", ")}`)
  }
  return summaries.join("; ")
}

function defaultRepositoryOptions(source: OnboardingSource): string[] {
  return source.githubPolicies.flatMap(({ repositories }) => repositories.map(({ fullName }) => fullName))
}

export function OnboardingApp({
  source,
  actions,
  githubConnectionState,
  completed,
  presentationOnlyCompleted = false,
  repositoryOptions,
  onOpenApp,
}: OnboardingAppProps) {
  const { settings, onboardingDraft, updateSettings, updateOnboardingDraft } = useSettings(source.applicationPreferences)
  const [draft, setDraft] = useState<OnboardingDraft>(() => {
    const restored = onboardingDraft ?? {
      currentStep: "dependencies" as const,
      machines: source.machineConfigurations.map((machine) => ({ ...machine })),
      unfinishedMachineEditor: null,
      workspaceSelections: initialWorkspaceSelections(source),
      workspaceIdentities: initialWorkspaceIdentities(source),
    }
    return completed ? { ...restored, currentStep: "review" } : restored
  })
  const currentDraft = useRef(draft)
  const recoveryCleared = useRef(false)
  const { currentStep: activeStep, machines, workspaceSelections, workspaceIdentities } = draft
  const viewModel = useMemo(() => projectOnboarding(source, githubConnectionState), [githubConnectionState, source])
  const applicationPreferences = {
    terminal: settings.terminal, editor: settings.editor, browser: settings.browser,
    terminalUseSystemDefault: settings.terminalUseSystemDefault,
    editorUseSystemDefault: settings.editorUseSystemDefault,
    browserUseSystemDefault: settings.browserUseSystemDefault,
    ...(settings.terminalPath && { terminalPath: settings.terminalPath }),
    ...(settings.editorPath && { editorPath: settings.editorPath }),
    ...(settings.browserPath && { browserPath: settings.browserPath }),
  }
  const availableRepositories = useMemo(
    () => uniqueRepositoryOptions(repositoryOptions ?? defaultRepositoryOptions(source)),
    [repositoryOptions, source],
  )

  // Completion comes from the existing action's result, never from a recovered
  // draft. A failed or unfinished completion leaves recovery data intact.
  useEffect(() => {
    if (completed && !presentationOnlyCompleted && !recoveryCleared.current) {
      recoveryCleared.current = true
      void updateOnboardingDraft(null)
    }
  }, [completed, presentationOnlyCompleted, updateOnboardingDraft])

  function updateDraft(changes: Partial<OnboardingDraft>) {
    if (completed || Object.entries(changes).every(([key, value]) => currentDraft.current[key as keyof OnboardingDraft] === value)) return
    const next = { ...currentDraft.current, ...changes }
    currentDraft.current = next
    setDraft(next)
    void updateOnboardingDraft(next)
  }

  function setActiveStep(currentStep: OnboardingStep) {
    updateDraft({ currentStep })
  }

  function move(offset: -1 | 1) {
    const current = onboardingSteps.indexOf(activeStep)
    const next = onboardingSteps[current + offset]
    if (next) setActiveStep(next)
  }

  function saveMachines(updated: SetupMachineConfiguration[]) {
    const request = configurationRequest(updated)
    const current = currentDraft.current
    const previousNameByID = new Map(current.machines.map(({ id, name }) => [id, name]))
    const selections = Object.fromEntries(request.machines.map(({ id, name }) => {
      const previousName = previousNameByID.get(id)
      return [name, current.workspaceSelections[name] ?? (previousName ? current.workspaceSelections[previousName] : undefined) ?? []]
    }))
    const identities = Object.fromEntries(request.machines.map(({ id, name }) => {
      const previousName = previousNameByID.get(id)
      return [name, current.workspaceIdentities[name] ?? (previousName ? current.workspaceIdentities[previousName] : undefined)
        ?? { ...(source.currentHostGitIdentity ?? { name: "", email: "" }), apply: true }]
    }))
    updateDraft({ machines: request.machines, workspaceSelections: selections, workspaceIdentities: identities, unfinishedMachineEditor: null })
    actions.saveMachineConfiguration(request)
  }

  function updateWorkspaceSelections(workspace: string, selections: WorkspaceRepositorySelection[]) {
    updateDraft({ workspaceSelections: { ...currentDraft.current.workspaceSelections, [workspace]: uniqueWorkspaceSelections(selections) } })
  }

  function updateWorkspaceIdentity(workspace: string, identity: WorkspaceGitIdentity) {
    updateDraft({ workspaceIdentities: { ...currentDraft.current.workspaceIdentities, [workspace]: identity } })
  }

  function resetWorkspaceIdentity(workspace: string) {
    if (!source.currentHostGitIdentity) return
    updateWorkspaceIdentity(workspace, { ...currentDraft.current.workspaceIdentities[workspace], ...source.currentHostGitIdentity })
  }

  function continueSetup() {
    if (completed) return
    if (activeStep === "review") {
      if (viewModel.finishEnabled) {
        actions.finishSetup({
          machineConfiguration: configurationRequest(machines),
          applications: applicationPreferences,
          github: {
            connectionState: githubConnectionState,
            workspaces: machines.map(({ name }) => ({
              workspace: name,
              repositories: [...(workspaceSelections[name] ?? [])],
              identity: { ...workspaceIdentities[name] },
            })),
          },
        })
      }
      return
    }
    move(1)
  }

  const machineNames = machines.map(({ name }) => name)
  const configuredWorkspaceCount = machineNames.filter((name) => (workspaceSelections[name] ?? []).length > 0).length
  const repositoryCount = machineNames.reduce((total, name) => total + (workspaceSelections[name] ?? []).length, 0)
  const pushEnabledRepositoryCount = machineNames.reduce(
    (total, name) => total + (workspaceSelections[name] ?? []).filter(({ allowPushes }) => allowPushes).length,
    0,
  )
  const repositoryLabel = repositoryCount === 1 ? "repository" : "repositories"
  const pushRepositoryLabel = pushEnabledRepositoryCount === 1 ? "repository" : "repositories"
  const githubSummary = githubConnectionState === "connected"
    ? `${repositoryCount} ${repositoryLabel} across ${configuredWorkspaceCount} of ${machines.length} sandboxes · ${pushEnabledRepositoryCount} push-enabled ${pushRepositoryLabel}`
    : "GitHub not connected"
  const identitySummary = workspaceIdentitySummary(
    workspaceIdentities,
    machineNames,
  )
  const machineWorkspaceViews = machines.map((machine): WorkspaceView => (
    viewModel.workspaceProgress.workspaces.find(({ name }) => name === machine.name)
      ?? { name: machine.name, status: "waiting", detail: machine.kind === "ssh" ? "Remote via SSH" : "Waiting" }
  ))
  return (
    <OnboardingShell
      activeStep={activeStep}
      viewModel={viewModel}
      onStepChange={setActiveStep}
      onBack={() => move(-1)}
      onContinue={continueSetup}
      completed={completed}
      onOpenApp={onOpenApp}
      reduceMotion={settings.reduceMotion}
    >
      <OnboardingPanel step="dependencies" activeStep={activeStep}>
        <DependenciesStep
          groups={viewModel.dependencies}
          applicationPreferences={applicationPreferences}
          onApplicationPreferencesChange={(preferences) => {
            void updateSettings(applicationPreferenceChanges(applicationPreferences, preferences))
          }}
          onRepairRuntime={actions.repairRuntime}
        />
      </OnboardingPanel>
      <OnboardingPanel step="workspaces" activeStep={activeStep}>
        <WorkspacesStep machines={machines} progress={viewModel.workspaceProgress} onMachinesChange={saveMachines} onRetry={actions.retryWorkspaceSetup} initialEditorDraft={draft.unfinishedMachineEditor} onEditorDraftChange={(unfinishedMachineEditor) => updateDraft({ unfinishedMachineEditor })} />
      </OnboardingPanel>
      <OnboardingPanel step="github" activeStep={activeStep}>
        <GitHubStep
          workspaces={machineWorkspaceViews}
          connectionState={githubConnectionState}
          repositoryOptions={availableRepositories}
          workspaceSelections={workspaceSelections}
          workspaceIdentities={workspaceIdentities}
          currentHostGitIdentity={source.currentHostGitIdentity}
          onConnect={actions.connectGitHub}
          onWorkspaceSelectionsChange={updateWorkspaceSelections}
          onWorkspaceIdentityChange={updateWorkspaceIdentity}
          onResetWorkspaceIdentity={resetWorkspaceIdentity}
        />
      </OnboardingPanel>
      <OnboardingPanel step="review" activeStep={activeStep}>
        {completed ? <SetupComplete machines={machines} githubSummary={githubSummary} /> : <ReviewStep
          onEditStep={setActiveStep}
          workspaceRetryable={viewModel.workspaceProgress.retryable}
          queueItems={viewModel.queueItems}
          machines={machines}
          githubSummary={githubSummary}
          identitySummary={identitySummary}
          errorMessage={viewModel.error?.message}
          errorRecovery={viewModel.error?.recovery ?? undefined}
          onRetryWorkspaceSetup={actions.retryWorkspaceSetup}
        />}
      </OnboardingPanel>
    </OnboardingShell>
  )
}
