import { useState, type FormEvent } from "react"
import { Dialog } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"

export function ForkStateDialog({ sandboxName, title, description, disabled, progressStage, fork, onClose }: {
  sandboxName: string
  /** Defaults to "Fork <sandboxName>"; a checkpoint fork names the source checkpoint. */
  title?: string
  /** Defaults to the current-state description; a checkpoint fork explains the source. */
  description?: string
  disabled: boolean
  progressStage?: string
  fork: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = name.trim()
    if (!title || disabled || busy) return
    setBusy(true)
    setError(null)
    try {
      await fork(title)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
      <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none">
        <Dialog.Title className="text-sm font-medium">{title ?? `Fork ${sandboxName}`}</Dialog.Title>
        <Dialog.Description className="mt-1 text-xs text-muted-foreground">{description ?? "Creates a stopped fork from the current state."}</Dialog.Description>
        <form className="mt-3 grid gap-2" onSubmit={submit}>
          <Input aria-label="New sandbox name" autoFocus maxLength={32} value={name} disabled={disabled || busy} placeholder="New sandbox name" onChange={event => setName(event.target.value)} />
          {busy && <div className="grid gap-1.5" role="status" aria-live="polite">
            <p className="text-xs text-muted-foreground">{progressStage || "Creating fork…"}</p>
            <Progress value={null} aria-label="Fork progress" />
          </div>}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={disabled || busy || !name.trim()}>Fork</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
