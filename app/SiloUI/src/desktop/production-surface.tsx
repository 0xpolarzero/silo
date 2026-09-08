import { useState } from "react"
import { SiloWindow } from "@/components/silo-window"
import { useDependencyStore, type DependencyStore } from "@/desktop/dependencies"
import { ProductionOnboarding } from "@/desktop/production-onboarding"
import { useProductionSource, type ProductionSource } from "@/desktop/production-source"
import { StatusPanel } from "@/desktop/status-panel"
import { ApplicationApp } from "@/features/application/application-app"
import { useSettings } from "@/features/preferences/settings-store"

export function Unavailable({ message, retry }: { message: string; retry?: () => void }) {
  return <SiloWindow title="Silo" label="Silo unavailable"><div className="grid flex-1 place-items-center p-6"><div className="max-w-lg rounded-lg border border-destructive/25 bg-destructive/[.06] p-4" role="alert"><h1 className="text-sm font-semibold">Silo could not load</h1><p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{message}</p>{retry && <button type="button" className="mt-3 rounded-md border px-3 py-1.5 text-xs" onClick={retry}>Retry</button>}</div></div></SiloWindow>
}

export function ProductionSurface({ source, dependencyStore, statusPanel = false }: { source: ProductionSource; dependencyStore: DependencyStore | null; statusPanel?: boolean }) {
  const current = useProductionSource(source)
  const dependencies = useDependencyStore(dependencyStore)
  const { settings: currentSettings } = useSettings()
  // Finish persists completion; keep this session on its preferences screen until Open Silo.
  const [onboardingActive, setOnboardingActive] = useState(() => !currentSettings.onboardingComplete)
  if (!statusPanel && onboardingActive && dependencies) {
    return <ProductionOnboarding application={current.source} dependencies={dependencies} source={source} onOpenApp={() => setOnboardingActive(false)} />
  }
  if (!current.source) {
    const message = current.error ?? (current.loading ? "Reading live sandbox state…" : "The native application state is unavailable. No sandbox state changed.")
    return <Unavailable message={message} retry={current.loading ? undefined : () => { void source.refresh() }} />
  }
  return statusPanel
    ? <StatusPanel source={current.source} actions={source.statusActions} />
    : <ApplicationApp source={current.source} actions={source.applicationActions} backup={current.backup} />
}

