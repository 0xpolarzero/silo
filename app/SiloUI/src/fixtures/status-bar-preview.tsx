import { useStatusBarFixture } from "./use-status-bar-fixture"
import { isTauri } from "@tauri-apps/api/core"

import { Button } from "@/components/ui/button"
import { WindowTitleBar } from "@/components/window-toolbar"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { StatusBar } from "@/features/status-bar/status-bar"
import type { StatusBarRoute } from "@/features/status-bar/status-bar-types"
import { type StatusBarFixtureMode } from "@/fixtures/status-bar-scenarios"

interface StatusBarPreviewProps {
  source: ApplicationSource
  mode?: StatusBarFixtureMode
  fixtureKey?: string
  onOpenSilo: (source: ApplicationSource, route?: StatusBarRoute) => void
}

export function StatusBarPreview({ fixtureKey, ...props }: StatusBarPreviewProps) {
  // Every fixture selection starts a new preview, including any simulated quit.
  return <StatusBarPreviewSession key={`${fixtureKey ?? "source"}:${props.mode ?? "source"}`} {...props} />
}

function StatusBarPreviewSession({ source, mode, onOpenSilo }: StatusBarPreviewProps) {
  const { source: snapshot, actions, launched, acknowledgement, relaunch } = useStatusBarFixture(source, mode, onOpenSilo)

  return (
    <main className="relative min-h-dvh bg-muted/50" aria-label="Status bar preview">
      {isTauri() && <WindowTitleBar title="Menu bar preview" />}
      <header className="flex h-9 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-sm">
        <span className="text-xs font-medium text-muted-foreground">Silo</span>
        <div className="flex h-full items-center">
          {launched && <StatusBar source={snapshot} actions={actions} defaultOpen />}
        </div>
      </header>
      <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center">
        <p className="text-xs text-muted-foreground/65">Menu bar preview</p>
      </div>
      <aside className="fixed bottom-24 left-5 z-10 max-w-[min(30rem,calc(100vw-2.5rem))] text-xs text-muted-foreground sm:bottom-5" aria-label="Preview feedback">
        <p role="status" aria-live="polite" aria-atomic="true">{acknowledgement}</p>
        {!launched && (
          <Button className="mt-2" variant="outline" size="xs" onClick={relaunch}>
            Relaunch Silo
          </Button>
        )}
      </aside>
    </main>
  )
}
