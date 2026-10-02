/* oxlint-disable react/only-export-components */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { z } from "zod"

export const updateSnapshotSchema = z.object({
  phase: z.enum(["idle", "checking", "available", "downloading", "ready", "installing", "error"]),
  lastChecked: z.string().nullable(), retryAction: z.enum(["check", "download", "install", "relaunch"]).nullable(),
  currentVersion: z.string(), availableVersion: z.string().nullable(), releaseNotes: z.string().nullable(),
  downloadedBytes: z.number().nonnegative(), totalBytes: z.number().positive().nullable(),
  automaticChecks: z.boolean(), packageKind: z.enum(["macos", "appimage", "debian", "manual"]),
  releaseUrl: z.string(), error: z.string().nullable(), errorDetails: z.string().nullable(),
  installBlockReason: z.string().nullable(),
  installStatus: z.string().nullable().optional(),
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
export interface Updates {
  snapshot: UpdateSnapshot | null
  connectionError: string | null
  pending: boolean
  installConfirmation: boolean
  requestInstall(): void
  cancelInstall(): void
  check(): void
  download(): void
  install(stopSandboxes: boolean): void
  setAutomaticChecks(enabled: boolean): void
  openRelease(): void
  reconnect(): void
}
const Context = createContext<Updates | null>(null)
export const useUpdates = () => useContext(Context)

function canRequestInstall(snapshot: UpdateSnapshot | null) {
  return Boolean(snapshot && snapshot.packageKind !== "manual" && snapshot.canInstall
    && (snapshot.phase === "ready" || snapshot.retryAction === "install" || (snapshot.packageKind === "debian" && snapshot.phase === "available"))
    && !["checking", "downloading", "installing"].includes(snapshot.phase))
}

export function UpdatesProvider({ backend, children }: { backend: UpdateBackend; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null)
  const [connection, setConnection] = useState(0)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const failureDelay = useRef(0)
  const subscriptionStatus = useRef<"connecting" | "connected" | "failed">("connecting")
  const receiveSnapshot = useCallback((next: UpdateSnapshot) => {
    setSnapshot(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    setConfirmVersion((version) => canRequestInstall(next) && version === next.availableVersion ? version : null)
  }, [])
  useEffect(() => {
    mounted.current = true
    subscriptionStatus.current = "connecting"
    let disposed = false
    let stop: (() => void) | undefined
    const receive = (next: UpdateSnapshot) => {
      if (!disposed) { failureDelay.current = 0; generation.current++; receiveSnapshot(next); setConnectionError(null) }
    }
    void (async () => {
      let before = generation.current
      try {
        stop = await backend.subscribe(receive)
        if (disposed) { stop(); return }
        subscriptionStatus.current = "connected"
        before = generation.current
        const next = await backend.read()
        if (!disposed && generation.current === before) receive(next)
      } catch {
        if (!disposed && (!stop || generation.current === before)) {
          if (!stop) subscriptionStatus.current = "failed"
          setConnectionError("Silo could not load updates. Try again.")
        }
      }
    })()
    return () => { disposed = true; mounted.current = false; stop?.() }
  }, [backend, connection, receiveSnapshot])
  useEffect(() => {
    let disposed = false
    let reading = false
    const refresh = async () => {
      if (reading || inFlight.current) return
      if (subscriptionStatus.current !== "connected") {
        if (subscriptionStatus.current === "failed") {
          subscriptionStatus.current = "connecting"
          setConnection((value) => value + 1)
        }
        return
      }
      reading = true
      const before = generation.current
      try {
        const next = await backend.read()
        if (!disposed && !inFlight.current && generation.current === before) {
          failureDelay.current = 0
          generation.current++
          receiveSnapshot(next)
          setConnectionError(null)
        }
      } catch {
        if (!disposed && !inFlight.current && generation.current === before) {
          failureDelay.current = Math.min(Math.max(failureDelay.current, 3000) * 2, 30000)
          setConnectionError("Silo could not refresh updates. Try again.")
        }
      } finally { reading = false }
    }
    // VM activity changes the installation gate independently of update progress.
    const polling = snapshot?.phase === "ready" || snapshot?.retryAction === "install" || (snapshot?.packageKind === "debian" && snapshot?.phase === "available")
    let timer: number | undefined
    const onFocus = () => {
      window.clearTimeout(timer)
      void refresh().finally(() => {
        if (!disposed && polling) {
          window.clearTimeout(timer)
          timer = window.setTimeout(onFocus, Math.max(3000, failureDelay.current))
        }
      })
    }
    window.addEventListener("focus", onFocus)
    if (polling) timer = window.setTimeout(onFocus, 3000)
    return () => { disposed = true; window.removeEventListener("focus", onFocus); window.clearTimeout(timer) }
  }, [backend, snapshot?.phase, snapshot?.retryAction, snapshot?.packageKind, receiveSnapshot])
  const run = (action: () => Promise<UpdateSnapshot | void>) => {
    if (inFlight.current) return
    inFlight.current = true
    generation.current++
    setPending(true)
    setConnectionError(null)
    const before = generation.current
    void action().then((next) => {
      // A command response must not replace newer progress emitted by the native updater.
      if (mounted.current && next && generation.current === before) receiveSnapshot(next)
    }).catch(() => {
      if (mounted.current) setConnectionError("The update action could not finish. Try again.")
    }).finally(() => {
      inFlight.current = false
      if (mounted.current) setPending(false)
    })
  }
  const canInstall = canRequestInstall(snapshot)
  return <Context value={{ snapshot, connectionError, pending,
    installConfirmation: Boolean(canInstall && confirmVersion && confirmVersion === snapshot?.availableVersion),
    requestInstall: () => {
      if (!canInstall || inFlight.current) return
      if (snapshot?.runningSandboxes.length) setConfirmVersion(snapshot.availableVersion)
      else { setConfirmVersion(null); run(() => backend.install(false)) }
    },
    cancelInstall: () => setConfirmVersion(null),
    check: () => run(backend.check), download: () => run(backend.download),
    install: (stop) => { setConfirmVersion(null); run(() => backend.install(stop)) },
    setAutomaticChecks: (enabled) => run(() => backend.setAutomaticChecks(enabled)),
    openRelease: () => run(backend.openRelease),
    reconnect: () => { setConnectionError(null); setConnection((value) => value + 1) },
  }}>{children}</Context>
}
