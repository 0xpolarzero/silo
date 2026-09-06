import { useEffect, useEffectEvent } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import type { ApplicationSource } from "@/features/application/model/application-source"
import type { StatusBarRoute } from "@/features/status-bar/status-bar-types"
import type { StatusFixture } from "./desktop-fixtures"

// Temporary, in-memory fixture transport. Product components only receive source/actions.
export function useDesktopFixtures(fixture: StatusFixture, onSnapshot: (source: ApplicationSource) => void, onOpen: (route?: StatusBarRoute) => void) {
  const publish = useEffectEvent(() => emitTo("status", "fixtures:source", fixture))
  const receiveSnapshot = useEffectEvent(onSnapshot)
  const receiveOpen = useEffectEvent(onOpen)
  const serialized = JSON.stringify(fixture)

  useEffect(() => {
    if (!isTauri()) return
    let active = true
    const subscriptions = [
      listen("fixtures:request", () => { if (active) void publish().catch(console.error) }),
      listen<ApplicationSource>("fixtures:snapshot", ({ payload }) => { if (active) receiveSnapshot(payload) }),
      listen<StatusBarRoute | null>("fixtures:open", ({ payload }) => { if (active) receiveOpen(payload ?? undefined) }),
    ]
    void Promise.all(subscriptions).then(() => { if (active) return publish() }).catch(console.error)
    return () => { active = false; subscriptions.forEach((subscription) => { void subscription.then((stop) => stop()) }) }
  }, [])

  useEffect(() => {
    if (isTauri()) void publish().catch(console.error)
  }, [serialized])
}

