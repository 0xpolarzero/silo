/* oxlint-disable react/only-export-components */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { z } from "zod"

export const updateSnapshotSchema = z.object({
  phase: z.enum(["idle", "checking", "available", "downloading", "ready", "installing", "error"]),
  lastChecked: z.string().nullable(), retryAction: z.enum(["check", "download", "install"]).nullable(),
  currentVersion: z.string(), availableVersion: z.string().nullable(), releaseNotes: z.string().nullable(),
  downloadedBytes: z.number().nonnegative(), totalBytes: z.number().positive().nullable(),
  automaticChecks: z.boolean(), packageKind: z.enum(["macos", "appimage", "manual"]),
  releaseUrl: z.string(), error: z.string().nullable(), errorDetails: z.string().nullable(),
  runningSandboxes: z.array(z.string()), canInstall: z.boolean(),
})
export type UpdateSnapshot = z.infer<typeof updateSnapshotSchema>
export interface UpdateBackend {
  read(): Promise<UpdateSnapshot>
  subscribe(receive: (snapshot: UpdateSnapshot) => void): Promise<() => void>
  check(): Promise<UpdateSnapshot>
  download(): Promise<UpdateSnapshot>
  install(stopSandboxes: boolean): Promise<UpdateSnapshot>
  setAutomaticChecks(enabled: boolean): Promise<UpdateSnapshot>
  openRelease(): Promise<void>
}
interface Updates {
  snapshot: UpdateSnapshot | null
  connectionError: string | null
  pending: boolean
  check(): void
  download(): void
  install(stopSandboxes: boolean): void
  setAutomaticChecks(enabled: boolean): void
  openRelease(): void
  reconnect(): void
}
const Context = createContext<Updates | null>(null)
export const useUpdates = () => useContext(Context)

export function UpdatesProvider({ backend, children }: { backend: UpdateBackend; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [connection, setConnection] = useState(0)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    mounted.current = true
    let disposed = false
    let stop: (() => void) | undefined
    const receive = (next: UpdateSnapshot) => {
      if (!disposed) { generation.current++; setSnapshot(next); setConnectionError(null) }
    }
    void (async () => {
      try {
        stop = await backend.subscribe(receive)
        if (disposed) { stop(); return }
        const before = generation.current
        const next = await backend.read()
        if (!disposed && generation.current === before) receive(next)
      } catch {
        if (!disposed) setConnectionError("Silo could not load updates. Try again.")
      }
    })()
    return () => { disposed = true; mounted.current = false; stop?.() }
  }, [backend, connection])
  useEffect(() => {
    let disposed = false
    let reading = false
    const refresh = async () => {
      if (reading || inFlight.current) return
      reading = true
      const before = generation.current
      try {
        const next = await backend.read()
        if (!disposed && !inFlight.current && generation.current === before) {
          generation.current++
          setSnapshot(next)
          setConnectionError(null)
        }
      } catch {
        if (!disposed) setConnectionError("Silo could not refresh updates. Try again.")
      } finally { reading = false }
    }
    const onFocus = () => { void refresh() }
    window.addEventListener("focus", onFocus)
    // VM activity changes the installation gate independently of update progress.
    const timer = (snapshot?.phase === "ready" || snapshot?.retryAction === "install") ? window.setInterval(onFocus, 3000) : undefined
    return () => { disposed = true; window.removeEventListener("focus", onFocus); if (timer !== undefined) window.clearInterval(timer) }
  }, [backend, snapshot?.phase, snapshot?.retryAction])
  const run = (action: () => Promise<UpdateSnapshot | void>) => {
    if (inFlight.current) return
    inFlight.current = true
    generation.current++
    setPending(true)
    setConnectionError(null)
    const before = generation.current
    void action().then((next) => {
      // A command response must not replace newer progress emitted by the native updater.
      if (mounted.current && next && generation.current === before) setSnapshot(next)
    }).catch(() => {
      if (mounted.current) setConnectionError("The update action could not finish. Try again.")
    }).finally(() => {
      inFlight.current = false
      if (mounted.current) setPending(false)
    })
  }
  return <Context value={{ snapshot, connectionError, pending,
    check: () => run(backend.check), download: () => run(backend.download),
    install: (stop) => run(() => backend.install(stop)),
    setAutomaticChecks: (enabled) => run(() => backend.setAutomaticChecks(enabled)),
    openRelease: () => run(backend.openRelease),
    reconnect: () => { setConnectionError(null); setConnection((value) => value + 1) },
  }}>{children}</Context>
}
