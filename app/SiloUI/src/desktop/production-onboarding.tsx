import { useMemo, useRef, useState } from "react"

import type { DependencyRuntime } from "@/desktop/dependencies"
import type { ProductionSource } from "@/desktop/production-source"
import type { SetupMachineConfigurationRequest, SetupMachineConfiguration, SiloBootstrapConfiguration } from "@/contracts/silo"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { OnboardingApp } from "@/features/onboarding/onboarding-app"
import type { OnboardingCompletionRequest, OnboardingSource } from "@/features/onboarding/model/onboarding-source"
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
export function productionOnboardingSource(application: ApplicationSource | null, dependencies: DependencyRuntime, applicationPreferences: OnboardingSource["applicationPreferences"]): OnboardingSource {
  const operation = application?.sandboxConfigurationOperation
  const machines = operation?.candidate.machines ?? application?.workspaces.map(({ machine }) => machine) ?? []
  const configured = (application?.workspaces.length ?? 0) > 0 && application!.workspaces.every(({ freshness, state }) => freshness === "fresh" && state !== "failed" && state !== "starting") && operation?.status !== "applying" && operation?.status !== "failed"
  const completedPhases = configured ? ["preflight", "toolchain", "hostIntegration", "workspaces"] as const : []
  return {
    readyToFinish: configured,
    machineConfigurations: [...machines],
    bootstrapConfiguration: bootstrapConfiguration(machines),
    bootstrapState: {
      phase: "workspaces",
      updatedAt: Date.now(),
      completedPhases: [...completedPhases],
      phaseDurations: {},
      ...(operation?.status === "failed" && { lastError: operation.error.message }),
    },
    preflightChecks: dependencies.checks,
    progressEvents: operation?.progressEvents ? [...operation.progressEvents] : [],
    githubPolicies: [],
    currentHostGitIdentity: application?.github.hostIdentity ?? null,
    applicationPreferences,
    bootstrapResult: configured ? { resumed: false, phase: "complete", requiresApproval: false, vmsStarted: false, message: "Sandbox configuration verified." } : operation?.status === "awaiting-approval" ? operation.result : null,
    error: operation?.status === "failed" ? operation.error : null,
  }
}

// oxlint-disable-next-line react/only-export-components
export async function finishProductionOnboarding(source: ProductionSource, request: OnboardingCompletionRequest, markComplete: () => Promise<void>) {
  if (request.github.workspaces.some(({ repositories }) => repositories.length > 0)) {
    throw new Error("Repository setup is not available yet. Remove the repository selections before finishing setup.")
  }
  await source.configureMachines(request.machineConfiguration)
  await source.configureIdentities(request.github.workspaces.map(({ workspace, identity }) => ({ workspace, ...identity })))
  await markComplete()
}

export function ProductionOnboarding({ application, dependencies, source }: { application: ApplicationSource | null; dependencies: DependencyRuntime; source: ProductionSource }) {
  const { settings, updateSettings, store } = useSettings()
  const lastConfiguration = useRef<SetupMachineConfigurationRequest | null>(null)
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
      const current = { ...productionOnboardingSource(application, dependencies, preferences), ...(finishing && { readyToFinish: false }) }
      return operationError ? { ...current, error: { code: "native_operation_failed", message: operationError, recovery: "Review the configuration and retry.", workspace: null, retryable: true } } : current
    },
    [application, dependencies, preferences, operationError, finishing],
  )
  return <OnboardingApp
    source={onboarding}
    completed={false}
    githubConnectionState={application?.github.state ?? "disconnected"}
    repositoryOptions={application?.github.repositoryCatalog}
    onRetryDependencies={dependencies.retry}
    actions={{
      connectGitHub: () => source.applicationActions.connectGitHub?.(),
      saveMachineConfiguration: (request) => {
        lastConfiguration.current = request
        setOperationError(null)
        void source.configureMachines(request).catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error)))
      },
      retryWorkspaceSetup: () => {
        setOperationError(null)
        const request = application?.sandboxConfigurationOperation?.candidate ?? lastConfiguration.current
        if (request) void source.configureMachines(request).catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error)))
      },
      finishSetup: (request) => {
        if (finishing) return
        setFinishing(true)
        setOperationError(null)
        void finishProductionOnboarding(source, request, async () => {
          await updateSettings({ ...request.applications, onboardingComplete: true })
          const error = store.getSnapshot().saveError
          if (error) throw new Error(error)
        })
          .catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error)))
          .finally(() => setFinishing(false))
      },
    }}
  />
}
