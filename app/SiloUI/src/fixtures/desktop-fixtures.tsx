import { useEffect, useState } from "react"
import { emitTo, listen } from "@tauri-apps/api/event"

import { desktopCommand } from "@/desktop/commands"
import { StatusPanel } from "@/desktop/status-panel"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { StatusBarFixtureMode } from "./status-bar-scenarios"
import { useStatusBarFixture } from "./use-status-bar-fixture"

export interface StatusFixture { source: ApplicationSource; mode?: StatusBarFixtureMode }

export function DesktopStatusFixture() {
  const [fixture, setFixture] = useState<StatusFixture | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    let previous = ""
    const subscription = listen<StatusFixture>("fixtures:source", ({ payload }) => {
      const serialized = JSON.stringify(payload)
      if (!active || serialized === previous) return
      previous = serialized
      setFixture(payload)
      setRevision((current) => current + 1)
    })
    void subscription.then(() => { if (active) return emitTo("main", "fixtures:request") }).catch(console.error)
    return () => { active = false; void subscription.then((stop) => stop()) }
  }, [])

  return fixture && <DesktopStatusFixtureSession key={revision} {...fixture} />
}

function DesktopStatusFixtureSession({ source, mode }: StatusFixture) {
  const fixture = useStatusBarFixture(source, mode, (snapshot, route) => {
    void emitTo("main", "fixtures:snapshot", snapshot)
      .then(() => emitTo("main", "fixtures:open", route ?? null))
      .then(() => desktopCommand("open_main"))
      .catch(console.error)
  })
  const serialized = JSON.stringify(fixture.source)
  useEffect(() => {
    void emitTo("main", "fixtures:snapshot", JSON.parse(serialized) as ApplicationSource).catch(console.error)
  }, [serialized])
  return <StatusPanel source={fixture.source} actions={fixture.actions} />
}
