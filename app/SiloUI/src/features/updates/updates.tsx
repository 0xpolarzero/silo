import { useState } from "react"
import { Download, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { InlineConfirmation } from "@/components/inline-confirmation"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { useUpdates, type UpdateSnapshot } from "./update-store"

function description(state: UpdateSnapshot) {
  switch (state.phase) {
    case "checking": return "Checking for updates…"
    case "available": return `Version ${state.availableVersion} is available.`
    case "downloading": return "Downloading update…"
    case "ready": return state.canInstall ? "Ready to install. Silo will restart." : state.installBlockReason ?? "Installation is unavailable. Try checking again."
    case "installing": return "Installing update. Silo will restart…"
    default: return state.phase === "idle" && state.lastChecked ? `Version ${state.currentVersion} · Silo is up to date` : `Version ${state.currentVersion}`
  }
}

export function UpdatesCard() {
  const updates = useUpdates()
  const [confirm, setConfirm] = useState(false)
  if (!updates) return null
  const { snapshot: state, pending } = updates
  const busy = pending || state?.phase === "checking" || state?.phase === "downloading" || state?.phase === "installing"
  const error = state?.error ?? updates.connectionError
  const installing = state?.phase === "ready" || state?.retryAction === "install"
  const requestInstall = () => { if (state?.runningSandboxes.length) setConfirm(true); else updates.install(false) }
  const retry = () => {
    if (!state) updates.reconnect()
    else if (state.retryAction === "download") updates.download()
    else if (state.retryAction === "install") requestInstall()
    else updates.check()
  }
  const percent = state?.totalBytes ? Math.min(100, Math.round(state.downloadedBytes / state.totalBytes * 100)) : undefined
  return <section className="grid gap-2" aria-label="Updates">
    <h3 className="text-xs font-medium">Updates</h3>
    <ListCard divided>
      <div>
        <ListRow icon={<ListRowIcon><Download aria-hidden="true" className="size-3.5" /></ListRowIcon>}
          title="Silo" detail={state ? description(state) : "Loading update settings…"} detailClassName="whitespace-normal"
          actions={<InlineConfirmation active={confirm} onDismiss={() => setConfirm(false)}>
            {confirm && installing && state ? <span className="flex shrink-0 gap-1.5">
              <Button size="xs" variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
              <Button size="xs" disabled={busy || !state.canInstall} onClick={() => { setConfirm(false); updates.install(true) }}>Stop sandboxes and update</Button>
            </span> : state?.phase === "available" ? <Button size="xs" variant="outline" disabled={busy} onClick={state.packageKind === "manual" ? updates.openRelease : updates.download}>{state.packageKind === "manual" ? "Download package" : "Download update"}</Button>
              : state?.phase === "ready" ? <Button size="xs" variant="outline" disabled={busy || !state.canInstall} onClick={requestInstall}>Restart and update</Button>
                : error || state?.phase === "downloading" || state?.phase === "installing" ? null : <Button size="xs" variant="outline" disabled={busy || !state} onClick={updates.check}><RefreshCw aria-hidden="true" className="size-3" />Check for updates</Button>}
          </InlineConfirmation>} />
        {confirm && installing && state && <p className="px-2 pb-2 text-[11px] text-muted-foreground">{state.runningSandboxes.join(", ")} will stop and restart after updating. Save your work before continuing.</p>}
        {state?.phase === "downloading" && <div className="px-2 pb-2">
          <div role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent === undefined ? `${state.downloadedBytes.toLocaleString()} bytes downloaded` : `${percent}%`} className="h-1 overflow-hidden rounded-full bg-muted">
            <div className={percent === undefined ? "h-full w-1/3 animate-pulse bg-primary motion-reduce:animate-none" : "h-full bg-primary"} style={percent === undefined ? undefined : { width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{percent === undefined ? `${(state.downloadedBytes / 1048576).toFixed(1)} MB downloaded` : `${percent}%`}</p>
        </div>}
        {error && <div role="alert" className="mx-2 mb-2 rounded-md border border-destructive/25 bg-destructive/[.06] p-2 text-xs">
          <div className="flex items-center justify-between gap-2"><p>{error}</p>{!confirm && <Button size="xs" variant="outline" disabled={busy || (state?.retryAction === "install" && !state.canInstall)} onClick={retry}>Retry</Button>}</div>
          {state?.errorDetails && <details className="mt-1 text-[11px] text-muted-foreground"><summary className="cursor-pointer">Details</summary><p className="mt-1 whitespace-pre-wrap break-words">{state.errorDetails}</p></details>}
        </div>}
        {state?.releaseNotes && state.availableVersion && <details className="px-2 pb-2 text-[11px] text-muted-foreground"><summary className="cursor-pointer">Release notes</summary><p className="mt-1 whitespace-pre-wrap break-words">{state.releaseNotes}</p></details>}
      </div>
      <ListRow icon={<ListRowIcon><RefreshCw aria-hidden="true" className="size-3.5" /></ListRowIcon>} title="Automatically check for updates" detail="Checks quietly. You choose when to download and install."
        detailClassName="whitespace-normal" actions={<Switch aria-label="Automatically check for updates" checked={state?.automaticChecks ?? false} disabled={!state || busy} onCheckedChange={updates.setAutomaticChecks} />} />
    </ListCard>
  </section>
}

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const updates = useUpdates()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const state = updates?.snapshot
  if (!state || !["available", "ready"].includes(state.phase) || !state.availableVersion || dismissed === `${state.availableVersion}:${state.phase}`) return null
  return <div role="status" className="flex items-center gap-2 border-b bg-muted/30 px-6 py-2 text-xs">
    <Download className="size-3.5" aria-hidden="true" />
    <span className="min-w-0 flex-1">Silo {state.availableVersion} {state.phase === "ready" ? "is ready to install." : "is available."}</span>
    <Button size="xs" variant="outline" onClick={onOpen}>View update</Button>
    <Button size="icon-xs" variant="ghost" aria-label="Dismiss update notice" onClick={() => setDismissed(`${state.availableVersion}:${state.phase}`)}><X className="size-3" /></Button>
  </div>
}
