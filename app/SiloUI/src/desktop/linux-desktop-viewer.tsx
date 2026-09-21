import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Ellipsis, Maximize, Monitor } from "lucide-react"
import { linuxDesktopStateSchema, type LinuxDesktopState, type DesktopAction } from "./linux-desktop-state"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"

export function LinuxDesktopViewer({ name, state, busy, error, onAction, onRetry, onFullscreen, screenRef, toolsUpdated = false }: {
  name: string
  state: LinuxDesktopState | null
  busy: boolean
  error: string | null
  onAction: (action: DesktopAction) => void
  onRetry: () => void
  onFullscreen: () => void
  screenRef?: React.RefObject<HTMLDivElement | null>
  toolsUpdated?: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirm, setConfirm] = useState<"stop" | "restart" | null>(null)
  const running = state?.state === "running"
  const toolsLabel = state?.ludaState === "ready" || state?.ludaState === "failed" || state?.ludaState === "installing" ? "Repair agent tools" : "Set up agent tools"
  const actionLabel = state?.state === "vm-stopped" ? state.autoStart ? "Start sandbox" : "Start sandbox and desktop" : state?.state === "failed" ? "Restart desktop" : "Start desktop"
  return <TooltipProvider><main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      <Monitor aria-hidden="true" className="size-4" /><h1 className="min-w-0 flex-1 truncate text-xs font-medium">{name}</h1>
      <Button variant="ghost" size="icon-xs" aria-label="Toggle fullscreen" onClick={onFullscreen}><Maximize /></Button>
      {running && <Button variant="ghost" size="icon-xs" aria-label="Desktop actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><Ellipsis /></Button>}
    </header>
    {running && menuOpen && <div role="group" aria-label="Desktop actions" className="flex shrink-0 justify-end gap-2 border-b border-border px-3 py-2">
      <Button size="xs" variant="outline" disabled={busy} onClick={() => { setConfirm("restart"); setMenuOpen(false) }}>Restart desktop</Button>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => { setConfirm("stop"); setMenuOpen(false) }}>Stop desktop</Button>
    </div>}
    {state?.installed && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs" aria-label="Agent desktop tools">
      <p className="flex-1">{state.ludaState === "ready" ? toolsUpdated ? "Agent tools ready. Reconnect existing agent sessions to load the tools." : "Agent desktop tools ready." : state.ludaState === "installing" ? "Setting up agent tools…" : state.ludaState === "failed" ? "Agent tools need repair." : state.state === "vm-stopped" ? "Start the sandbox to check agent tools, or set them up now." : "Set up Luda so agents can use the desktop."}</p>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => onAction("setup-tools")}>{toolsLabel}</Button>
    </div>}
    {confirm && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs" role="alert">
      <p className="flex-1">{confirm === "stop" ? "Stopping" : "Restarting"} the desktop closes its graphical applications.</p>
      <Button size="xs" variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
      <Button size="xs" onClick={() => { onAction(confirm); setConfirm(null) }}>{confirm === "stop" ? "Stop desktop" : "Restart desktop"}</Button>
    </div>}
    {error && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs"><p className="flex-1">{error}</p><Button size="xs" variant="outline" disabled={busy} onClick={onRetry}>Reconnect</Button></div>}
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
    if (action === "setup-tools") setState(current => current ? { ...current, ludaState: "installing" } : current)
    setError(null)
    try {
      const result = linuxDesktopStateSchema.parse(await invoke("desktop_action", { workspace, action }))
      setState(result)
      if (action === "setup-tools") setToolsUpdated(result.ludaState === "ready")
    }
    catch (cause) { setError(String(cause)); if (action === "setup-tools") setState(current => current ? { ...current, ludaState: "failed" } : current) }
    finally { operation.current = false; setBusy(false) }
  }
  return <LinuxDesktopViewer name={name} state={state} busy={busy} error={error ?? connectionError} screenRef={screenRef} toolsUpdated={toolsUpdated}
    onAction={action => { void handleAction(action) }}
    onRetry={() => { setConnection(value => value + 1); void refresh() }}
    onFullscreen={() => { const window = getCurrentWindow(); void window.isFullscreen().then(value => window.setFullscreen(!value)).catch(cause => setError(String(cause))) }} />
}
