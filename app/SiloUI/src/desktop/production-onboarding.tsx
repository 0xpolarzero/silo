import { useEffect, useMemo, useRef, useState } from "react"

import type { DependencyRuntime } from "@/desktop/dependencies"
import { useProductionSource, type ProductionSnapshot, type ProductionSource } from "@/desktop/production-source"
import type { SetupMachineConfigurationRequest, SetupMachineConfiguration, SiloBootstrapConfiguration } from "@/contracts/silo"
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
  const operation = application?.sandboxConfigurationOperation
  const machines = setup?.setupCandidate?.machines ?? operation?.candidate.machines ?? application?.workspaces.map(({ machine }) => machine) ?? []
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

export function ProductionOnboarding({ application, dependencies, source }: { application: ApplicationSource | null; dependencies: DependencyRuntime; source: ProductionSource }) {
  const setup = useProductionSource(source)
  const [, tick] = useState(0)
  const setupRunning = setup.setupQueue.some(({ status }) => status === "running")
  useEffect(() => {
    if (!setupRunning) return
    const timer = window.setInterval(() => tick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [setupRunning])
  const { settings, updateSettings, store } = useSettings()
  const lastConfiguration = useRef<SetupMachineConfigurationRequest | null>(null)
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
  function submit(operation: () => Promise<unknown>, isFinishing = false) {
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

  return <OnboardingApp
    source={onboarding}
    completed={false}
    githubConnectionState={application?.github.state ?? "disconnected"}
    repositoryOptions={application?.github.repositoryCatalog}
    onRetryDependencies={dependencies.retry}
    actions={{
      submitStep: (step, request) => {
        lastConfiguration.current = request.machineConfiguration
        submit(() => source.submitSetupStep(step, request))
      },
      connectGitHub: () => source.applicationActions.connectGitHub?.(),
      saveMachineConfiguration: (request) => {
        lastConfiguration.current = request
        submit(() => source.configureMachines(request))
      },
      retryWorkspaceSetup: () => {
        const request = lastConfiguration.current ?? application?.sandboxConfigurationOperation?.candidate
        if (request) submit(() => source.configureMachines(request))
      },
      finishSetup: (request) => {
        if (finishing) return
        submit(() => source.finishSetup(request, async () => {
          await updateSettings({ ...request.applications, onboardingComplete: true })
          const error = store.getSnapshot().saveError
          if (error) throw new Error(error)
        }), true)
      },
    }}
  />
}
