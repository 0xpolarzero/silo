import { useEffect, useState } from "react"
import { CheckIcon, CircleAlertIcon, CircleIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { formatElapsed } from "@/lib/format-elapsed"

export type OperationStepState = "done" | "current" | "pending" | "failed"
export interface OperationStep { label: string; state: OperationStepState }

export interface OperationCancel {
  /** Button label. Defaults to "Cancel". */
  label?: string
  /** When set, clicking the button swaps the toast body to an inline confirmation. */
  confirm?: { prompt: string; confirmLabel: string; keepLabel?: string }
  onCancel: () => void
}

export interface OperationProgressOptions {
  title: string
  /** The current step, e.g. "Saving disk copies". */
  step?: string
  steps?: OperationStep[]
  /** 0–1 when known; null/undefined renders an indeterminate bar. */
  progress?: number | null
  /** Epoch ms the operation began; drives the elapsed timer. Defaults to when the toast first rendered. */
  startedAt?: number
  cancel?: OperationCancel
  /** Sandbox this notification is about (see `dismissSandboxToasts`). */
  sandbox?: string | string[]
}

function useElapsed(startedAt: number | undefined) {
  const [fallback] = useState(() => Date.now())
  const start = startedAt ?? fallback
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return formatElapsed(now - start)
}

const stepIcon: Record<OperationStepState, React.ReactNode> = {
  done: <CheckIcon className="size-3 text-muted-foreground" aria-hidden />,
  current: <Loader2Icon className="size-3 animate-spin" aria-hidden />,
  pending: <CircleIcon className="size-3 text-muted-foreground/50" aria-hidden />,
  failed: <CircleAlertIcon className="size-3 text-destructive" aria-hidden />,
}

/** Body of a progress toast (rendered as the Sonner description). Use `showOperationProgress`. */
/**
 * True when a step line only repeats the title ("Creating checkpoint…" under "Creating
 * checkpoint “X”"). Compared case-insensitively, ignoring quotes and ellipses.
 */
function isRedundantStep(title: string | undefined, step: string | undefined): boolean {
  if (!step) return true
  if (!title) return false
  const normalize = (text: string) => text.toLowerCase().replace(/[“”‘’"'`]/g, "").replace(/(\.{3}|…)/g, "").replace(/\s+/g, " ").trim()
  const normalizedStep = normalize(step)
  return normalizedStep.length === 0 || normalize(title).startsWith(normalizedStep)
}

export function OperationToastBody({ title, step, steps, progress, startedAt, cancel }: Omit<OperationProgressOptions, "title"> & { title?: string }) {
  const elapsed = useElapsed(startedAt)
  const [confirming, setConfirming] = useState(false)
  const value = progress == null ? null : Math.min(100, Math.max(0, progress * 100))

  if (confirming && cancel?.confirm) {
    const { prompt, confirmLabel, keepLabel = "Keep going" } = cancel.confirm
    return <div className="grid gap-2 text-xs" role="group" aria-label="Confirm cancel">
      <p>{prompt}</p>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" autoFocus onClick={() => setConfirming(false)}>{keepLabel}</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => { setConfirming(false); cancel.onCancel() }}>{confirmLabel}</Button>
      </div>
    </div>
  }

  const showStep = !isRedundantStep(title, step)
  return <div className="grid w-full min-w-0 gap-1.5 text-xs">
    <Progress className="w-full" value={value} aria-label={step ?? title ?? "Progress"} />
    <div className="flex min-w-0 items-center justify-between gap-2 text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={showStep ? step : undefined}>{showStep ? step : null}</span>
      <span className="shrink-0 tabular-nums" data-slot="operation-elapsed">{elapsed}</span>
    </div>
    {steps && steps.length > 0 && <ul className="grid gap-0.5" aria-label="Steps">
      {steps.map((entry) => <li key={entry.label} data-state={entry.state} className={`flex items-center gap-1.5 ${entry.state === "pending" ? "text-muted-foreground/70" : entry.state === "failed" ? "text-destructive" : ""}`}>
        {stepIcon[entry.state]}<span className="min-w-0 truncate">{entry.label}</span>
      </li>)}
    </ul>}
    {cancel && <div className="flex justify-end"><Button type="button" variant="outline" size="xs" onClick={() => (cancel.confirm ? setConfirming(true) : cancel.onCancel())}>{cancel.label ?? "Cancel"}</Button></div>}
  </div>
}
