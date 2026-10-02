import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"

import { TabsContent } from "@/components/ui/tabs"
import { DeletionConfirmation } from "@/features/onboarding/components/deletion-confirmation"
import { SetupComplete } from "@/features/onboarding/components/setup-complete"
import type { ApplicationGitHubWorkspacePolicy } from "@/features/application/model/application-source"
import type { SetupMachineConfiguration } from "@/contracts/silo"
import { OnboardingShell } from "@/features/onboarding/components/onboarding-shell"
import type {
  GitHubConnectionState,
  OnboardingActions,
  OnboardingCompletionRequest,
  OnboardingSource,
  OnboardingSubmissionOptions,
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
import { SettingsSaveNotice } from "@/features/preferences/components/settings-save-notice"
import { applicationPreferenceChanges } from "@/features/preferences/model/application-preferences"

export interface OnboardingAppProps {
  source: OnboardingSource
  actions: OnboardingActions
  githubConnectionState: GitHubConnectionState
  operationError?: string | null
  completed: boolean
  presentationOnlyCompleted?: boolean
  repositoryOptions?: readonly string[]
  repositoryPolicies?: readonly ApplicationGitHubWorkspacePolicy[]
  tokenConnected?: boolean
  onOpenApp?: () => void
  onRetryDependencies?: () => void
  onConnectComputer?: () => void
}

function OnboardingPanel({ step, activeStep, notice, children }: { step: OnboardingStep; activeStep: OnboardingStep; notice?: ReactNode; children: ReactNode }) {
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
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-5 sm:px-6 sm:py-6">{active && <SettingsSaveNotice />}{active && notice}{children}</div>
  </TabsContent>
}

function repositoryKey(repository: string): string {
  return repository.toLowerCase()
}

function workspaceValue<T>(values: Record<string, T> | undefined, name: string): T | undefined {
  return values && Object.hasOwn(values, name) ? values[name] : undefined
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

function defaultWorkspaceIdentity(source: OnboardingSource): WorkspaceGitIdentity {
  const { name = "", email = "" } = source.currentHostGitIdentity ?? {}
  return { name, email, apply: Boolean(name.trim() && email.trim()) }
}

function initialWorkspaceIdentities(source: OnboardingSource): Record<string, WorkspaceGitIdentity> {
  return Object.fromEntries(source.machineConfigurations.map((workspace) => [
    workspace.name,
    defaultWorkspaceIdentity(source),
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
    const identity = workspaceValue(identities, workspace)
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
      ? `all ${workspaceNames.length} ${workspaceNames.length === 1 ? "sandbox" : "sandboxes"}`
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
  operationError,
  completed,
  presentationOnlyCompleted = false,
  repositoryOptions,
  repositoryPolicies,
  tokenConnected = false,
  onOpenApp,
  onRetryDependencies,
  onConnectComputer,
}: OnboardingAppProps) {
  const { settings, onboardingDraft, updateSettings, updateOnboardingDraft } = useSettings(source.applicationPreferences)
  const [draft, setDraft] = useState<OnboardingDraft>(() => {
    const restored = onboardingDraft ?? {
      currentStep: "dependencies" as const,
      machines: source.machineConfigurations.map((machine) => ({ ...machine })),
      unfinishedMachineEditor: null,
      workspaceRepositoryAccess: Object.fromEntries((repositoryPolicies ?? []).map((policy) => [policy.workspace, { repositoryMode: policy.repositoryMode ?? "selected", allRepositoriesAllowChanges: policy.allRepositoriesAllowChanges ?? false, ...(policy.authenticationMethod ? { authenticationMethod: policy.authenticationMethod } : {}) }])),
      workspaceSelections: repositoryPolicies ? Object.fromEntries(repositoryPolicies.map((policy) => [policy.workspace, [...policy.repositories]])) : initialWorkspaceSelections(source),
      workspaceIdentities: repositoryPolicies ? { ...initialWorkspaceIdentities(source), ...Object.fromEntries(repositoryPolicies.map((policy) => [policy.workspace, { ...policy.identity }])) } : initialWorkspaceIdentities(source),
    }
    return completed ? { ...restored, currentStep: "review" } : restored
  })
  // A restored draft is the user's; otherwise the draft is seeded again from this
  // computer's sandboxes once they load (a fallback seed is only a placeholder).
  const machinesInitialized = useRef(onboardingDraft !== null || (draft.machines.length > 0 && source.machinesAuthoritative !== false))
  const currentDraft = useRef(draft)
  const editedIdentities = useRef(new Set(Object.keys(onboardingDraft?.workspaceIdentities ?? {})))
  const editedSelections = useRef(new Set(Object.keys(onboardingDraft?.workspaceSelections ?? {})))
  const editedRepositoryAccess = useRef(new Set(Object.keys(onboardingDraft?.workspaceRepositoryAccess ?? {})))
  const editedAuthenticationMethods = useRef(new Set(Object.entries(onboardingDraft?.workspaceRepositoryAccess ?? {}).filter(([, access]) => access.authenticationMethod !== undefined).map(([name]) => name)))
  const policiesInitialized = useRef(new Set(onboardingDraft ? [] : (repositoryPolicies ?? []).map(({ workspace }) => workspace)))
  const recoveryCleared = useRef(false)
  // Existing sandboxes the user deleted with the list's own Delete confirmation.
  const confirmedRemovals = useRef(new Set<string>())
  const [pendingDeletion, setPendingDeletion] = useState<{ machines: SetupMachineConfiguration[]; run: () => void } | null>(null)
  const { currentStep: activeStep, machines, workspaceSelections, workspaceIdentities } = draft
  const viewModel = useMemo(() => {
    const projectedSource = source.setupQueue ? {
      ...source,
      machineConfigurations: machines,
      bootstrapConfiguration: { ...source.bootstrapConfiguration, workspaces: machines.flatMap((machine) => machine.kind === "vm" ? [{ name: machine.name, cpu: machine.cpus, cpuCeiling: machine.maxCPUs, memoryGiB: machine.memoryGiB, memoryCeilingGiB: machine.maxMemoryGiB, workspaceStorageGiB: machine.workspaceStorageGiB, runtimeStorageGiB: machine.runtimeStorageGiB }] : []) },
    } : source
    return projectOnboarding(projectedSource, githubConnectionState)
  }, [githubConnectionState, source, machines])
  const applicationPreferences = useMemo(() => ({
    terminal: settings.terminal, editor: settings.editor, browser: settings.browser,
    terminalUseSystemDefault: settings.terminalUseSystemDefault,
    editorUseSystemDefault: settings.editorUseSystemDefault,
    browserUseSystemDefault: settings.browserUseSystemDefault,
    ...(settings.terminalPath && { terminalPath: settings.terminalPath }),
    ...(settings.editorPath && { editorPath: settings.editorPath }),
    ...(settings.browserPath && { browserPath: settings.browserPath }),
  }), [settings])
  const completionInputs = useRef({ applications: applicationPreferences, githubConnectionState })
  useEffect(() => {
    completionInputs.current = { applications: applicationPreferences, githubConnectionState }
  }, [applicationPreferences, githubConnectionState])
  const availableRepositories = useMemo(
    () => uniqueRepositoryOptions(repositoryOptions ?? defaultRepositoryOptions(source)),
    [repositoryOptions, source],
  )

  useEffect(() => {
    const current = currentDraft.current
    if (machinesInitialized.current || current.unfinishedMachineEditor || source.machineConfigurations.length === 0) return
    const authoritative = source.machinesAuthoritative !== false
    if (authoritative) machinesInitialized.current = true
    const machines = source.machineConfigurations.map((machine) => ({ ...machine }))
    if (JSON.stringify(machines) === JSON.stringify(current.machines)) return
    // Keep choices already made for sandboxes that remain in the list.
    const names = new Set(machines.map(({ name }) => name))
    const kept = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name)))
    const next = { ...current, machines,
      workspaceSelections: { ...initialWorkspaceSelections(source), ...kept(current.workspaceSelections) },
      workspaceIdentities: { ...initialWorkspaceIdentities(source), ...kept(current.workspaceIdentities) },
    }
    currentDraft.current = next
    setDraft(next)
    // A placeholder seed is not saved as the user's draft.
    if (authoritative) void updateOnboardingDraft(next)
  }, [source, draft.unfinishedMachineEditor, updateOnboardingDraft])

  useEffect(() => {
    if (completed || !repositoryPolicies) return
    const current = currentDraft.current
    const names = new Set(current.machines.map(({ name }) => name))
    const next = { ...current,
      workspaceRepositoryAccess: { ...current.workspaceRepositoryAccess },
      workspaceSelections: { ...current.workspaceSelections },
      workspaceIdentities: { ...current.workspaceIdentities },
    }
    let changed = false
    for (const policy of repositoryPolicies) {
      const name = policy.workspace
      if (!names.has(name) || policiesInitialized.current.has(name)) continue
      policiesInitialized.current.add(name)
      if (!editedRepositoryAccess.current.has(name)) {
        next.workspaceRepositoryAccess[name] = { repositoryMode: policy.repositoryMode ?? "selected", allRepositoriesAllowChanges: policy.allRepositoriesAllowChanges ?? false }
        changed = true
      }
      if (!editedAuthenticationMethods.current.has(name) && policy.authenticationMethod) {
        next.workspaceRepositoryAccess[name] = {
          ...next.workspaceRepositoryAccess[name], authenticationMethod: policy.authenticationMethod,
        }
        changed = true
      }
      if (!editedSelections.current.has(name)) {
        next.workspaceSelections[name] = policy.repositories.map((repository) => ({ ...repository }))
        changed = true
      }
      if (!editedIdentities.current.has(name)) {
        next.workspaceIdentities[name] = { ...policy.identity }
        changed = true
      }
    }
    if (!changed) return
    currentDraft.current = next
    setDraft(next)
    void updateOnboardingDraft(next)
  }, [completed, repositoryPolicies, machines, updateOnboardingDraft])

  useEffect(() => {
    const host = source.currentHostGitIdentity
    if (completed || !host) return
    const current = currentDraft.current
    const identities = { ...current.workspaceIdentities }
    let changed = false
    for (const { name } of current.machines) {
      const identity = workspaceValue(identities, name)
      if (editedIdentities.current.has(name) || (identity?.apply === false && policiesInitialized.current.has(name)) || identity?.name.trim() || identity?.email.trim()) continue
      identities[name] = { ...host, apply: Boolean(host.name.trim() && host.email.trim()) }
      changed = true
    }
    if (!changed) return
    const next = { ...current, workspaceIdentities: identities }
    currentDraft.current = next
    setDraft(next)
    void updateOnboardingDraft(next)
  }, [completed, source.currentHostGitIdentity, machines, updateOnboardingDraft])

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

  // Existing sandboxes a submission would delete without the user having deleted them.
  function unconfirmedDeletions(): SetupMachineConfiguration[] {
    const kept = new Set(currentDraft.current.machines.map(({ id }) => id))
    return (source.existingMachines ?? []).filter(({ id }) => !kept.has(id) && !confirmedRemovals.current.has(id))
  }

  // Trailing submission arguments: the confirmed deletions, when there are any.
  function submissionOptions(): [] | [OnboardingSubmissionOptions] {
    return confirmedRemovals.current.size ? [{ confirmedDeletions: [...confirmedRemovals.current] }] : []
  }

  // Every submission builds its request from the draft when it runs, after any
  // confirmation below.
  function submitChecked(run: () => void) {
    const missing = unconfirmedDeletions()
    if (missing.length === 0) { setPendingDeletion(null); run(); return }
    setPendingDeletion({ machines: missing, run })
  }

  function keepExistingMachines() {
    const pending = pendingDeletion
    if (!pending) return
    setPendingDeletion(null)
    const existing = source.existingMachines ?? []
    const existingIds = new Set(existing.map(({ id }) => id))
    const restoredNames = new Set(pending.machines.map(({ name }) => name.toLowerCase()))
    const current = currentDraft.current
    // A new draft sandbox reusing a restored name (typically the default seeded before
    // the real sandboxes loaded) would collide with it, so it gives way.
    const machines = current.machines.filter(({ id, name }) => existingIds.has(id) || !restoredNames.has(name.toLowerCase()))
    for (const machine of pending.machines) {
      machines.splice(Math.min(existing.findIndex(({ id }) => id === machine.id), machines.length), 0, { ...machine })
    }
    const host = defaultWorkspaceIdentity(source)
    const savedPolicies = new Map((repositoryPolicies ?? []).map((policy) => [policy.workspace, policy]))
    updateDraft({
      machines,
      workspaceSelections: Object.fromEntries(machines.map(({ name }) => [name, workspaceValue(current.workspaceSelections, name) ?? savedPolicies.get(name)?.repositories.map((repository) => ({ ...repository })) ?? []])),
      workspaceIdentities: Object.fromEntries(machines.map(({ name }) => [name, workspaceValue(current.workspaceIdentities, name) ?? { ...(savedPolicies.get(name)?.identity ?? host) }])),
      workspaceRepositoryAccess: Object.fromEntries(machines.map(({ name }) => {
        const policy = savedPolicies.get(name)
        return [name, workspaceValue(current.workspaceRepositoryAccess, name) ?? {
          repositoryMode: policy?.repositoryMode ?? "selected" as const,
          allRepositoriesAllowChanges: policy?.allRepositoriesAllowChanges ?? false,
          ...(policy?.authenticationMethod ? { authenticationMethod: policy.authenticationMethod } : {}),
        }]
      })),
    })
    pending.run()
  }

  function deleteExistingMachines() {
    const pending = pendingDeletion
    if (!pending) return
    setPendingDeletion(null)
    for (const { id } of pending.machines) confirmedRemovals.current.add(id)
    pending.run()
  }

  function saveMachines(updated: SetupMachineConfiguration[]) {
    const request = configurationRequest(updated)
    machinesInitialized.current = true
    const current = currentDraft.current
    // The list asks before deleting a sandbox; that confirmation covers existing ones.
    const remaining = new Set(request.machines.map(({ id }) => id))
    for (const { id } of current.machines) if (!remaining.has(id)) confirmedRemovals.current.add(id)
    const previousNameByID = new Map(current.machines.map(({ id, name }) => [id, name]))
    const selections = Object.fromEntries(request.machines.map(({ id, name }) => {
      const previousName = previousNameByID.get(id)
      return [name, workspaceValue(current.workspaceSelections, name) ?? (previousName ? workspaceValue(current.workspaceSelections, previousName) : undefined) ?? []]
    }))
    const identities = Object.fromEntries(request.machines.map(({ id, name }) => {
      const previousName = previousNameByID.get(id)
      return [name, workspaceValue(current.workspaceIdentities, name) ?? (previousName ? workspaceValue(current.workspaceIdentities, previousName) : undefined)
        ?? defaultWorkspaceIdentity(source)]
    }))
    const workspaceRepositoryAccess = Object.fromEntries(request.machines.map(({ id, name }) => [name, workspaceValue(current.workspaceRepositoryAccess, name) ?? workspaceValue(current.workspaceRepositoryAccess, previousNameByID.get(id) ?? "") ?? { repositoryMode: "selected" as const, allRepositoriesAllowChanges: false }]))
    updateDraft({ machines: request.machines, workspaceRepositoryAccess, workspaceSelections: selections, workspaceIdentities: identities, unfinishedMachineEditor: null })
    submitChecked(() => actions.saveMachineConfiguration(configurationRequest(currentDraft.current.machines), ...submissionOptions()))
  }

  function updateWorkspaceSelections(workspace: string, selections: WorkspaceRepositorySelection[]) {
    editedSelections.current.add(workspace)
    updateDraft({ workspaceSelections: { ...currentDraft.current.workspaceSelections, [workspace]: uniqueWorkspaceSelections(selections) } })
  }

  function updateWorkspaceIdentity(workspace: string, identity: WorkspaceGitIdentity) {
    editedIdentities.current.add(workspace)
    updateDraft({ workspaceIdentities: { ...currentDraft.current.workspaceIdentities, [workspace]: identity } })
  }

  function resetWorkspaceIdentity(workspace: string) {
    if (!source.currentHostGitIdentity) return
    updateWorkspaceIdentity(workspace, { ...(workspaceValue(currentDraft.current.workspaceIdentities, workspace) ?? { apply: false }), ...source.currentHostGitIdentity })
  }

  function completionRequest(): OnboardingCompletionRequest {
    // A deletion confirmation can retain this callback across settings and
    // connection changes. Read the latest inputs when the user confirms.
    const { applications, githubConnectionState } = completionInputs.current
    return {
      machineConfiguration: { schemaVersion: 1, machines: [...currentDraft.current.machines] },
      applications,
      github: {
        connectionState: githubConnectionState,
        workspaces: currentDraft.current.machines.map(({ name }) => ({
          workspace: name,
          ...(githubConnectionState === "connected" ? workspaceValue(currentDraft.current.workspaceRepositoryAccess, name) : undefined),
          repositories: githubConnectionState === "connected" ? [...(workspaceValue(currentDraft.current.workspaceSelections, name) ?? [])] : [],
          identity: { ...(workspaceValue(currentDraft.current.workspaceIdentities, name) ?? { name: "", email: "", apply: false }) },
        })),
      },
    }
  }

  function continueSetup() {
    if (completed) return
    if (activeStep === "review") {
      if (viewModel.finishEnabled) submitChecked(() => actions.finishSetup(completionRequest(), ...submissionOptions()))
      return
    }
    if (activeStep === "workspaces" || activeStep === "github") {
      const step = activeStep
      const next = onboardingSteps[onboardingSteps.indexOf(step) + 1]
      submitChecked(() => { actions.submitStep?.(step, completionRequest(), ...submissionOptions()); setActiveStep(next) })
      return
    }
    move(1)
  }

  // Retry rebuilds the request from the current draft, so edits since the failed
  // attempt (identities, repository choices, sandboxes) apply.
  function retrySetup() {
    if (completed) return
    submitChecked(() => actions.retryWorkspaceSetup(completionRequest(), ...submissionOptions()))
  }

  const machineNames = machines.map(({ name }) => name)
  const allWorkspaceCount = machineNames.filter((name) => workspaceValue(draft.workspaceRepositoryAccess, name)?.repositoryMode === "all").length
  const allWriteWorkspaceCount = machineNames.filter((name) => {
    const access = workspaceValue(draft.workspaceRepositoryAccess, name)
    return access?.repositoryMode === "all" && access.allRepositoriesAllowChanges
  }).length
  const configuredWorkspaceCount = machineNames.filter((name) => (workspaceValue(workspaceSelections, name) ?? []).length > 0).length
  const repositoryCount = machineNames.reduce((total, name) => total + (workspaceValue(workspaceSelections, name) ?? []).length, 0)
  const pushEnabledRepositoryCount = machineNames.reduce(
    (total, name) => total + (workspaceValue(workspaceSelections, name) ?? []).filter(({ allowPushes }) => allowPushes).length,
    0,
  )
  const repositoryLabel = repositoryCount === 1 ? "repository" : "repositories"
  const pushRepositoryLabel = pushEnabledRepositoryCount === 1 ? "repository" : "repositories"
  const githubSummary = githubConnectionState === "connected"
    ? allWorkspaceCount > 0 ? `All authorized repositories in ${allWorkspaceCount} ${allWorkspaceCount === 1 ? "sandbox" : "sandboxes"} · ${allWriteWorkspaceCount} allowing GitHub changes` : `${repositoryCount} ${repositoryLabel} across ${configuredWorkspaceCount} of ${machines.length} ${machines.length === 1 ? "sandbox" : "sandboxes"} · ${pushEnabledRepositoryCount} ${pushRepositoryLabel} allowing GitHub changes`
    : "GitHub not connected"
  const identitySummary = workspaceIdentitySummary(
    workspaceIdentities,
    machineNames,
  )
  const deletionNotice = pendingDeletion && !completed
    ? <DeletionConfirmation machines={pendingDeletion.machines} onKeep={keepExistingMachines} onDelete={deleteExistingMachines} />
    : null
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
      <OnboardingPanel step="dependencies" activeStep={activeStep} notice={deletionNotice}>
        <DependenciesStep
          groups={viewModel.dependencies}
          applicationPreferences={applicationPreferences}
          onApplicationPreferencesChange={(preferences) => {
            void updateSettings(applicationPreferenceChanges(applicationPreferences, preferences))
          }}
          onRetry={onRetryDependencies}
          onConnectComputer={onConnectComputer}
        />
      </OnboardingPanel>
      <OnboardingPanel step="workspaces" activeStep={activeStep} notice={deletionNotice}>
        <WorkspacesStep onConnectComputer={onConnectComputer} machines={machines} progress={viewModel.workspaceProgress} onMachinesChange={saveMachines} onRetry={retrySetup} initialEditorDraft={draft.unfinishedMachineEditor} onEditorDraftChange={(unfinishedMachineEditor) => updateDraft({ unfinishedMachineEditor })} />
      </OnboardingPanel>
      <OnboardingPanel step="github" activeStep={activeStep} notice={deletionNotice}>
        <GitHubStep
          queueItems={viewModel.queueItems}
          activityEvents={source.activityEvents ?? source.progressEvents}
          workspaces={machineWorkspaceViews}
          connectionState={githubConnectionState}
          tokenConnected={tokenConnected}
          notice={operationError ? <p role="alert" className="text-xs text-destructive">{operationError}</p> : undefined}
          repositoryOptions={availableRepositories}
          workspaceSelections={Object.fromEntries(machineNames.map((name) => [name, workspaceValue(workspaceSelections, name) ?? []]))}
          workspaceRepositoryAccess={Object.fromEntries(machineNames.map((name) => [name, workspaceValue(draft.workspaceRepositoryAccess, name) ?? { repositoryMode: "selected", allRepositoriesAllowChanges: false }]))}
          onWorkspaceRepositoryAccessChange={(workspace, access) => {
            if (access.authenticationMethod !== currentDraft.current.workspaceRepositoryAccess?.[workspace]?.authenticationMethod) editedAuthenticationMethods.current.add(workspace)
            editedRepositoryAccess.current.add(workspace)
            updateDraft({ workspaceRepositoryAccess: { ...currentDraft.current.workspaceRepositoryAccess, [workspace]: access } })
          }}
          workspaceIdentities={Object.fromEntries(machineNames.map((name) => [name, workspaceValue(workspaceIdentities, name) ?? { name: "", email: "", apply: false }]))}
          currentHostGitIdentity={source.currentHostGitIdentity}
          onConnect={actions.connectGitHub}
          onCancelConnection={actions.cancelGitHubConnection}
          onReopenAuthorization={actions.reopenGitHubAuthorization}
          onWorkspaceSelectionsChange={updateWorkspaceSelections}
          onWorkspaceIdentityChange={updateWorkspaceIdentity}
          onResetWorkspaceIdentity={resetWorkspaceIdentity}
        />
      </OnboardingPanel>
      <OnboardingPanel step="review" activeStep={activeStep} notice={deletionNotice}>
        {completed ? <SetupComplete machines={machines} githubSummary={githubSummary} /> : <ReviewStep
          onEditStep={setActiveStep}
          workspaceRetryable={viewModel.workspaceProgress.retryable}
          queueItems={viewModel.queueItems}
          workspaces={viewModel.workspaceProgress.workspaces}
          machines={machines}
          githubConnected={githubConnectionState === "connected"}
          githubSummary={githubSummary}
          identitySummary={identitySummary}
          errorMessage={viewModel.error?.message}
          errorRecovery={viewModel.error?.recovery ?? undefined}
          onRetryWorkspaceSetup={retrySetup}
          finishBlocker={viewModel.finishBlocker}
          onStartWorkspace={actions.startWorkspace}
          onRefresh={actions.refreshSetupState}
        />}
      </OnboardingPanel>
    </OnboardingShell>
  )
}
