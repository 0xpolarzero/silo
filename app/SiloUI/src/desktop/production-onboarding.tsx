import { SiloWindow } from "@/components/silo-window"
import { ConnectComputerForm } from "@/features/application/components/remote-computers-settings"
import { useEffect, useMemo, useRef, useState } from "react"

import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"

import type { DependencyRuntime } from "@/desktop/dependencies"
import { useProductionSource, type ProductionSnapshot, type ProductionSource } from "@/desktop/production-source"
import type { SetupMachineConfiguration, SiloBootstrapConfiguration } from "@/contracts/silo"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { OnboardingApp } from "@/features/onboarding/onboarding-app"
import type { OnboardingSource } from "@/features/onboarding/model/onboarding-source"
import { useSettings } from "@/features/preferences/settings-store"

function bootstrapConfiguration(machines: readonly SetupMachineConfiguration[]): SiloBootstrapConfiguration {
  return {
    schemaVersion: 1,
    workspaces: machines.flatMap((machine) => machine.kind === "vm" ? [{
      name: machine.name,
      cpu: machine.cpus,
      cpuCeiling: machine.maxCPUs,
      memoryGiB: machine.memoryGiB,
      memoryCeilingGiB: machine.maxMemoryGiB,
      workspaceStorageGiB: machine.workspaceStorageGiB,
      runtimeStorageGiB: machine.runtimeStorageGiB,
    }] : []),
  }
}

// oxlint-disable-next-line react/only-export-components
export function productionOnboardingSource(application: ApplicationSource | null, dependencies: DependencyRuntime, applicationPreferences: OnboardingSource["applicationPreferences"], setup?: ProductionSnapshot): OnboardingSource {
  // Setup on this computer must never adopt another computer's VM identities.
  if (application) application = { ...application, workspaces: application.workspaces.filter(workspace => !workspace.computer) }
  const operation = application?.sandboxConfigurationOperation
  const machines = setup?.setupCandidate?.machines ?? operation?.candidate.machines ?? (application?.workspaces.length ? application.workspaces.map(({ machine }) => machine) : productionMachineDefaults)
  const configured = (application?.workspaces.length ?? 0) > 0 && application!.workspaces.every(({ freshness, state }) => freshness === "fresh" && state !== "failed" && state !== "starting") && operation?.status !== "applying" && operation?.status !== "failed"
  const completedPhases = configured ? ["preflight", "toolchain", "hostIntegration", "workspaces"] as const : []
  return {
    ...(setup && { setupQueue: setup.setupQueue.map((item) => configured && item.status === "idle" && ["workspaceRun", "workspaceVerify"].includes(item.id) ? { ...item, status: "succeeded" as const } : item) }),
    readyToFinish: configured && !setup?.setupQueue.some(({ id, status }) => ["workspaceRun", "workspaceVerify"].includes(id) && (status === "running" || status === "queued" || status === "failed")),
    machineConfigurations: [...machines],
    bootstrapConfiguration: bootstrapConfiguration(machines),
    bootstrapState: {
      phase: "workspaces",
      updatedAt: setup?.setupFinishedAt ?? Math.floor(Date.now() / 1000),
      ...(setup?.setupStartedAt && { startedAt: setup.setupStartedAt }),
      completedPhases: [...completedPhases],
      phaseDurations: {},
      ...(operation?.status === "failed" && { lastError: operation.error.message }),
    },
    preflightChecks: dependencies.checks,
    progressEvents: setup ? setup.setupEvents : operation?.progressEvents ? [...operation.progressEvents] : [],
    activityEvents: setup?.setupActivity,
    activityError: setup?.setupActivityError,
    githubPolicies: [],
    currentHostGitIdentity: application?.github.hostIdentity ?? null,
    applicationPreferences,
    bootstrapResult: configured ? { resumed: false, phase: "complete", requiresApproval: false, vmsStarted: false, message: "Sandbox configuration verified." } : operation?.status === "awaiting-approval" ? operation.result : null,
    error: operation?.status === "failed" ? operation.error : null,
  }
}

export function ProductionOnboarding({ application, dependencies, source, onOpenApp }: { application: ApplicationSource | null; dependencies: DependencyRuntime; source: ProductionSource; onOpenApp?: () => void }) {
  const setup = useProductionSource(source)
  const [, tick] = useState(0)
  const setupRunning = setup.setupQueue.some(({ status }) => status === "running")
  useEffect(() => {
    if (!setupRunning) return
    const timer = window.setInterval(() => tick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [setupRunning])
  const { settings, onboardingDraft, updateSettings, store } = useSettings()
  const lastSubmission = useRef<{ operation: () => Promise<unknown>; isFinishing: boolean } | null>(null)
  const [completed, setCompleted] = useState(false)
  const [connectingComputer, setConnectingComputer] = useState(false)
  const submissionSequence = useRef(0)
  const [finishing, setFinishing] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const preferences = useMemo(() => ({
    terminal: settings.terminal,
    editor: settings.editor,
    browser: settings.browser,
    terminalPath: settings.terminalPath,
    editorPath: settings.editorPath,
    browserPath: settings.browserPath,
    terminalUseSystemDefault: settings.terminalUseSystemDefault,
    editorUseSystemDefault: settings.editorUseSystemDefault,
    browserUseSystemDefault: settings.browserUseSystemDefault,
  }), [settings])
  const onboarding = useMemo(
    () => {
      const current = { ...productionOnboardingSource(application, dependencies, preferences, { ...setup, backup: setup.backup.state }), ...(finishing && { readyToFinish: false }) }
      return operationError ? { ...current, error: { code: "native_operation_failed", message: operationError, recovery: "Review the configuration and retry.", workspace: current.error?.workspace ?? (application === null ? setup.setupEvents.at(-1)?.workspace ?? null : null), retryable: true } } : current
    },
    [application, dependencies, preferences, operationError, finishing, setup],
  )
  useEffect(() => {
    if (!onboardingDraft?.machines.length || completed) return
    void source.verifySetupIdentities({
      machineConfiguration: { schemaVersion: 1, machines: onboardingDraft.machines },
      github: {
        connectionState: application?.github.state ?? "disconnected",
        workspaces: onboardingDraft.machines.map(({ name }) => ({
          workspace: name,
          repositories: [],
          identity: onboardingDraft.workspaceIdentities[name] ?? { name: "", email: "", apply: false },
        })),
      },
    })
  }, [source, onboardingDraft, application?.github.state, completed])

  function submit(operation: () => Promise<unknown>, isFinishing = false) {
    lastSubmission.current = { operation, isFinishing }
    const sequence = ++submissionSequence.current
    setOperationError(null)
    setFinishing(isFinishing)
    void operation().then(() => {
      if (sequence === submissionSequence.current) setOperationError(null)
    }).catch((error: unknown) => {
      if (sequence === submissionSequence.current) setOperationError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (sequence === submissionSequence.current) setFinishing(false)
    })
  }

  if (connectingComputer && source.applicationActions.connectComputer) {
    return <SiloWindow title="Silo" label="Connect another computer">
      <div className="mx-auto w-full max-w-lg p-6">
        <h1 className="mb-3 text-sm font-semibold">Connect another computer</h1>
        <ConnectComputerForm authorize={source.applicationActions.authorizeComputer} onClose={() => setConnectingComputer(false)} connect={async address => {
          await source.applicationActions.connectComputer!(address)
          await updateSettings({ onboardingComplete: true })
          await store.flush()
          const error = store.getSnapshot().saveError
          if (error) throw new Error(error)
          onOpenApp?.()
        }} />
      </div>
    </SiloWindow>
  }
  return <OnboardingApp
    onConnectComputer={source.applicationActions.connectComputer ? () => setConnectingComputer(true) : undefined}
    source={onboarding}
    completed={completed}
    onOpenApp={onOpenApp}
    githubConnectionState={application?.github.state ?? "disconnected"}
    repositoryOptions={application?.github.repositoryCatalog}
    repositoryPolicies={application?.github.workspaces}
    onRetryDependencies={dependencies.retry}
    actions={{
      submitStep: (step, request) => {
        submit(() => source.submitSetupStep(step, request))
      },
      connectGitHub: () => source.applicationActions.connectGitHub?.(),
      saveMachineConfiguration: (request) => {
        submit(() => source.configureMachines(request))
      },
      retryWorkspaceSetup: () => {
        if (finishing) return
        const previous = lastSubmission.current
        if (previous) submit(previous.operation, previous.isFinishing)
        else if (application?.sandboxConfigurationOperation?.status === "failed") {
          const request = application.sandboxConfigurationOperation.candidate
          submit(() => source.configureMachines(request))
        }
      },
      finishSetup: (request) => {
        if (finishing) return
        submit(async () => {
          await source.finishSetup(request, async () => {
            await updateSettings({ ...request.applications, onboardingComplete: true })
            const error = store.getSnapshot().saveError
            if (error) throw new Error(error)
          })
          setCompleted(true)
        }, true)
      },
    }}
  />
}
