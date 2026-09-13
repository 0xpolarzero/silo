import { ShutdownBoundary } from "@/desktop/shutdown-boundary"
import { desktopUpdateBackend } from "@/desktop/updates"
import { UpdatesProvider, useUpdates } from "@/features/updates/update-store"
import { useMainRoute } from "@/desktop/use-main-route"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { SiloPreflightCheck } from "@/contracts/silo"
import { SiloWindow } from "@/components/silo-window"
import { useDependencyStore, type DependencyStore } from "@/desktop/dependencies"
import { ProductionOnboarding } from "@/desktop/production-onboarding"
import { useProductionSource, type ProductionSource } from "@/desktop/production-source"
import { StatusPanel } from "@/desktop/status-panel"
import { ApplicationLoading } from "@/desktop/application-loading"
import { ApplicationApp } from "@/features/application/application-app"
import { useSettings } from "@/features/preferences/settings-store"

export function Unavailable({ message, retry, checks = [], checking = false }: { message: string; retry?: () => void; checks?: SiloPreflightCheck[]; checking?: boolean }) {
  return (
    <SiloWindow title="Silo" label="Silo unavailable">
      <div className="grid flex-1 place-items-center p-6">
        <div className="max-w-lg rounded-lg border border-destructive/25 bg-destructive/[.06] p-4" role="alert">
          <h1 className="text-sm font-semibold">Silo could not load</h1>
          {checks.length ? checks.map((check) => (
            <div key={check.id} className="mt-2 text-xs">
              <p>{check.title}: {check.detail}</p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{check.remediation}</p>
            </div>
          )) : <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{message}</p>}
          {retry && <button type="button" disabled={checking} className="mt-3 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50" onClick={retry}>{checking ? "Checking…" : "Retry checks"}</button>}
        </div>
      </div>
    </SiloWindow>
  )
}

type ProductionSurfaceProps = { source: ProductionSource; dependencyStore: DependencyStore | null; statusPanel?: boolean }
export function ProductionSurface(props: ProductionSurfaceProps) {
  return props.statusPanel ? <ProductionContent {...props} /> : <ShutdownBoundary><ProductionContent {...props} /></ShutdownBoundary>
}
function ProductionContent({ source, dependencyStore, statusPanel = false }: ProductionSurfaceProps) {
  const current = useProductionSource(source)
  const routeRequest = useMainRoute(!statusPanel)
  const dependencies = useDependencyStore(dependencyStore)
  const { settings: currentSettings, store: settingsStore } = useSettings()
  const [preparingUpdate, setPreparingUpdate] = useState(false)
  const updateBackend = useMemo(() => ({ ...desktopUpdateBackend, install: async (stopSandboxes: boolean) => {
    setPreparingUpdate(true)
    try {
      await settingsStore.flush()
      return await desktopUpdateBackend.install(stopSandboxes)
    } finally {
      setPreparingUpdate(false)
    }
  } }), [settingsStore])
  const checks = dependencies?.checks
  const [previousFailures, setPreviousFailures] = useState<SiloPreflightCheck[]>([])
  useEffect(() => {
    const failures = checks?.filter(({ status }) => ["failed", "unavailable", "timeout"].includes(status)) ?? []
    // Retain actionable guidance while the read-only checks run again.
    // oxlint-disable-next-line react/set-state-in-effect
    if (checks && !checks.some(({ status }) => status === "pending")) setPreviousFailures(failures)
  }, [checks])
  const checking = checks?.some(({ status }) => status === "pending") ?? false
  const failures = checking ? previousFailures : checks?.filter(({ status }) => ["failed", "unavailable", "timeout"].includes(status)) ?? []
  const retryChecks = () => { dependencies?.retry(); void source.refresh() }
  // Finish persists completion; keep this session on its preferences screen until Open Silo.
  const [onboardingActive, setOnboardingActive] = useState(() => !currentSettings.onboardingComplete)
  if (!statusPanel && onboardingActive && dependencies) {
    return <UpdatesProvider backend={updateBackend}><UpdateInstallationBoundary preparing={preparingUpdate}><ProductionOnboarding application={current.source} dependencies={dependencies} source={source} onOpenApp={() => setOnboardingActive(false)} /></UpdateInstallationBoundary></UpdatesProvider>
  }
  if (!current.source) {
    if (current.loading && !current.error && !failures.length) return <ApplicationLoading machines={current.savedMachines ?? []} statusPanel={statusPanel} />
    const message = current.error ?? "The native application state is unavailable. No sandbox state changed."
    return <Unavailable message={message} checks={failures} checking={checking} retry={current.loading ? undefined : retryChecks} />
  }
  const remoteOnly = Boolean(current.source.remoteComputers?.length)
    && !current.source.workspaces.some(workspace => !workspace.computer && workspace.machine.kind === "vm")
  const localRuntimeFailures = remoteOnly ? [] : failures
  return statusPanel
    ? <StatusPanel source={current.source} actions={source.statusActions} />
    : <UpdatesProvider backend={updateBackend}><UpdateInstallationBoundary preparing={preparingUpdate}><ApplicationApp routeRequest={routeRequest} source={localRuntimeFailures.length ? { ...current.source, runtimeRepair: {
      status: "unavailable", checking,
      reason: failures.map(({ title, detail }) => `${title}: ${detail}`).join("\n"),
      recovery: [...new Set(failures.map(({ remediation }) => remediation).filter(Boolean))].join("\n"),
    } } : current.source} actions={{ ...source.applicationActions, retryRuntimeChecks: retryChecks }} backup={current.backup} /></UpdateInstallationBoundary></UpdatesProvider>
}

function UpdateInstallationBoundary({ preparing, children }: { preparing: boolean; children: ReactNode }) {
  const updates = useUpdates()
  const installing = updates?.snapshot?.phase === "installing"
  const blocked = preparing || installing
  return <div className="flex h-full min-h-0 flex-col">
    {blocked && <div role="status" className="border-b bg-muted px-4 py-2 text-xs">{installing ? "Installing update. Silo will restart…" : "Preparing update…"}</div>}
    <div className="flex min-h-0 flex-1 flex-col" inert={blocked} aria-busy={blocked}>{children}</div>
  </div>
}
