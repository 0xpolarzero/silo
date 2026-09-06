import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import { desktopCommand } from "./commands"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { StatusBarContent } from "@/features/status-bar/status-bar"
import { statusBarHealth } from "@/features/status-bar/status-bar-model"
import type { StatusBarActions } from "@/features/status-bar/status-bar-types"

export function StatusPanel({ source, actions }: { source: ApplicationSource; actions: StatusBarActions }) {
  const content = useRef<HTMLDivElement>(null)
  const [opening, setOpening] = useState(0)
  const health = statusBarHealth(source)

  useEffect(() => {
    const element = content.current!
    const observer = new ResizeObserver(() => {
      void invoke("resize_status", { height: element.getBoundingClientRect().height }).catch(console.error)
    })
    observer.observe(element)
    const unlisten = listen("desktop:status-opened", () => {
      setOpening((current) => current + 1)
      element.focus()
    })
    return () => { observer.disconnect(); void unlisten.then((stop) => stop()) }
  }, [])

  useEffect(() => {
    void invoke("update_tray", { tone: health.tone, label: health.label }).catch(console.error)
  }, [health.tone, health.label])

  function dismissThen(action: () => void) { void desktopCommand("hide_status").then(action) }
  const nativeActions: StatusBarActions = {
    ...actions,
    quit: () => { void desktopCommand("quit_app") },
    openTerminal: (name) => dismissThen(() => actions.openTerminal(name)),
    openEditor: (name, path) => dismissThen(() => actions.openEditor(name, path)),
    openSite: (name, port) => dismissThen(() => actions.openSite(name, port)),
  }

  return <TooltipProvider delayDuration={150}>
    <div ref={content} role="dialog" aria-label="Silo" tabIndex={-1}
      className="silo-window flex max-h-[520px] w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground outline-none"
      data-reduce-motion={source.preferences.reduceMotion}
      onKeyDown={(event) => {
        // Nested menus consume Escape first; the next Escape dismisses the panel.
        if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); void desktopCommand("hide_status") }
      }}>
      <StatusBarContent key={opening} source={source} actions={nativeActions} focusContent={() => content.current?.focus()} />
    </div>
  </TooltipProvider>
}
