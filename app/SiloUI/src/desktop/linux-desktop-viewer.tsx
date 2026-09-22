import { useCallback, useEffect, useRef, useState, type ComponentType } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { CircleAlert, Maximize, Monitor } from "lucide-react"
import { linuxDesktopStateSchema, type LinuxDesktopState, type DesktopAction } from "./linux-desktop-state"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DesktopActionsMenu, NativeDesktopActionsMenu, type DesktopMenuProps } from "./linux-desktop-menu"

export function LinuxDesktopViewer({ name, state, busy, error, onAction, onRetry, onFullscreen, screenRef, toolsUpdated = false, MenuComponent = DesktopActionsMenu }: {
  name: string
  state: LinuxDesktopState | null
  busy: boolean
  error: string | null
  onAction: (action: DesktopAction) => void
  onRetry: () => void
  onFullscreen: () => void
  screenRef?: React.RefObject<HTMLDivElement | null>
  toolsUpdated?: boolean
  MenuComponent?: ComponentType<DesktopMenuProps>
}) {
  const [menuError, setMenuError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<"stop" | "restart" | null>(null)
  const running = state?.state === "running"
  const toolsUnavailable = state?.installed && state.state !== "vm-stopped" && (state.ludaState === "missing" || state.ludaState === "failed")
  const problem = error ?? menuError
  const actionLabel = state?.state === "vm-stopped" ? state.autoStart ? "Start sandbox" : "Start sandbox and desktop" : state?.state === "failed" ? "Restart desktop" : "Start desktop"
  return <TooltipProvider><main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      <Monitor aria-hidden="true" className="size-4" /><h1 className="min-w-0 flex-1 truncate text-xs font-medium">{name}</h1>
      {confirm ? <div role="alert" className="flex min-w-0 items-center gap-2 text-xs">
        <p className="truncate" title="This closes the desktop's graphical applications.">{confirm === "stop" ? "Stopping" : "Restarting"} the desktop closes its graphical applications.</p>
        <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
        <Button size="xs" disabled={busy} onClick={() => { onAction(confirm); setConfirm(null) }}>{confirm === "stop" ? "Stop desktop" : "Restart desktop"}</Button>
      </div> : <>
        {(toolsUnavailable || problem) && <div role="alert" className="flex min-w-0 items-center gap-1 text-xs text-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate" title={problem ?? undefined}>{toolsUnavailable ? "Agent tools unavailable" : problem}</span>
          {toolsUnavailable ? <Button size="xs" variant="ghost" disabled={busy} aria-label="Repair agent tools" onClick={() => onAction("setup-tools")}>Repair</Button>
            : error && <Button size="xs" variant="ghost" disabled={busy} onClick={onRetry}>Reconnect</Button>}
        </div>}
        {state?.installed && state.state !== "vm-stopped" && state.ludaState === "installing" && <span role="status" className="text-xs text-muted-foreground">Setting up agent tools…</span>}
        {toolsUpdated && state?.ludaState === "ready" && <span role="status" className="text-xs text-muted-foreground">Reconnect agent sessions to load the tools.</span>}
      </>}
      <Button variant="ghost" size="icon-xs" aria-label="Toggle fullscreen" onClick={onFullscreen}><Maximize /></Button>
      {running && <MenuComponent busy={busy} onSelect={action => { setMenuError(null); setConfirm(action) }} onError={setMenuError} />}
    </header>
    {running ? <div ref={screenRef} className="min-h-0 flex-1" aria-label="Linux desktop display" /> : <div className="grid min-h-0 flex-1 place-items-center p-6 text-center" aria-busy={busy}>
      <div className="grid max-w-sm justify-items-center gap-3">
        <Monitor aria-hidden="true" className="size-8 text-muted-foreground" />
        <p className="text-sm">{busy && state?.ludaState === "installing" ? "Setting up agent tools…" : busy || state?.state === "starting" ? "Connecting to desktop…" : !state ? "Desktop unavailable" : state.state === "uninstalled" ? "Desktop is not installed" : state.state === "failed" ? "Desktop needs attention" : state.state === "vm-stopped" ? "Sandbox is stopped" : "Desktop is stopped"}</p>
        {state && state.state !== "uninstalled" && state.state !== "starting" && <Button disabled={busy} size="sm" onClick={() => onAction(state.state === "failed" ? "restart" : "start")}>{actionLabel}</Button>}
        {state?.state === "uninstalled" && <p className="text-xs text-muted-foreground">Add a desktop in the sandbox configuration.</p>}
      </div>
    </div>}
  </main></TooltipProvider>
}

export function NativeLinuxDesktopViewer({ workspace, name }: { workspace: string; name: string }) {
  const [state, setState] = useState<LinuxDesktopState | null>(null)
  const [busy, setBusy] = useState(true)
  const [toolsUpdated, setToolsUpdated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connection, setConnection] = useState(0)
  const screenRef = useRef<HTMLDivElement>(null)
  const operation = useRef(false)
  const polling = useRef(false)
  const revision = useRef(0)
  const transportTail = useRef<Promise<void>>(Promise.resolve())
  const transport = useCallback((work: () => Promise<void>) => {
    const next = transportTail.current.catch(() => {}).then(work)
    transportTail.current = next
    return next
  }, [])
  const refresh = useCallback(async () => {
    if (operation.current || polling.current) return
    polling.current = true
    const currentRevision = revision.current
    try {
      const result = linuxDesktopStateSchema.parse(await invoke("read_desktop_state", { workspace }))
      if (currentRevision === revision.current) { setState(result); setError(null) }
    } catch (cause) { if (currentRevision === revision.current) setError(String(cause)) }
    finally { polling.current = false; if (currentRevision === revision.current) setBusy(false) }
  }, [workspace])
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh() }, 0)
    const interval = window.setInterval(() => { void refresh() }, 5000)
    return () => { window.clearTimeout(initial); window.clearInterval(interval) }
  }, [refresh])
  useEffect(() => {
    if (state?.state !== "running" || !screenRef.current) {
      void transport(() => invoke("desktop_viewer_detach")).catch(cause => setError(String(cause)))
      return
    }
    const screen = screenRef.current
    let disposed = false
    let pending = false
    let dirty = false
    async function attach() {
      if (disposed) return
      if (pending) { dirty = true; return }
      const { x, y, width, height } = screen.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      if (width <= 0 || height <= 0) return
      pending = true
      try { await transport(async () => { if (!disposed) await invoke("desktop_viewer_attach", { workspace, x, y, width, height, viewportHeight }) }); if (!disposed) setConnectionError(null) }
      catch (cause) { if (!disposed) setConnectionError(String(cause)) }
      finally { pending = false; if (dirty) { dirty = false; void attach() } }
    }
    const updateBounds = () => { void attach() }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(screen)
    window.addEventListener("resize", updateBounds)
    void attach()
    return () => { disposed = true; observer.disconnect(); window.removeEventListener("resize", updateBounds); void transport(() => invoke("desktop_viewer_detach")).catch(() => {}) }
  }, [workspace, state?.state, connection, transport])
  async function handleAction(action: DesktopAction) {
    if (operation.current) return
    operation.current = true
    revision.current += 1
    setBusy(true)
    const previous = state
    if (action === "setup-tools") { setToolsUpdated(false); setState(current => current ? { ...current, ludaState: "installing" } : current) }
    setError(null)
    try {
      const result = linuxDesktopStateSchema.parse(await invoke("desktop_action", { workspace, action }))
      setState(result)
      if (action === "setup-tools") setToolsUpdated(result.ludaState === "ready")
    }
    catch (cause) { setError(String(cause)); if (action === "setup-tools") setState(previous) }
    finally { operation.current = false; setBusy(false) }
  }
  return <LinuxDesktopViewer name={name} state={state} busy={busy} error={error ?? connectionError} screenRef={screenRef} toolsUpdated={toolsUpdated} MenuComponent={NativeDesktopActionsMenu}
    onAction={action => { void handleAction(action) }}
    onRetry={() => { setConnection(value => value + 1); void refresh() }}
    onFullscreen={() => { const window = getCurrentWindow(); void window.isFullscreen().then(value => window.setFullscreen(!value)).catch(cause => setError(String(cause))) }} />
}
