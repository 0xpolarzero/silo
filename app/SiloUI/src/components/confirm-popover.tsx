import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * Ask in a popover, do in a toast. Use `ConfirmPopover` for yes/no confirmations and
 * `FormPopover` for one or two small fields, anchored to the button that triggered them.
 * On confirm the popover closes immediately; run the work from `onConfirm`/`onSubmit` and
 * report progress with `showOperationProgress` (lib/operation-toast.ts). Errors are the
 * caller's to toast. Dialogs are only for the ⌘K palette and the quit overlay.
 *
 * `children` is the click trigger (asChild). `FormPopover` takes its inputs via `fields`.
 *
 * External anchor (popover opened without clicking its trigger, e.g. native menu
 * "File → Import Sandbox…"): omit the trigger, control `open`, and pass the target button as
 * `anchor`; it is wrapped in a Radix Popover.Anchor so the menu handler only calls `setOpen(true)`:
 *
 *   <FormPopover open={open} onOpenChange={setOpen} anchor={<Button>Add</Button>} ... />
 */
interface PopoverShellProps {
  title: string
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: "default" | "destructive"
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
  /** Trigger element (asChild). */
  children?: ReactNode
  /** External anchor: the popover positions against this instead of a trigger. */
  anchor?: ReactNode
  /** Forwarded to the anchor element, so popovers can be nested around one button. */
  ref?: Ref<HTMLElement>
}

function useOpen(open: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined) {
  const [inner, setInner] = useState(false)
  const value = open ?? inner
  const set = (next: boolean) => { if (open === undefined) setInner(next); onOpenChange?.(next) }
  return [value, set] as const
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value)
  else if (ref) ref.current = value
}

function Shell({ open, setOpen, children, anchor, anchorRef, align, side, content }: {
  anchorRef?: Ref<HTMLElement>
  open: boolean
  setOpen: (open: boolean) => void
  children?: ReactNode
  anchor?: ReactNode
  align: "start" | "center" | "end"
  side: "top" | "right" | "bottom" | "left"
  content: ReactNode
}) {
  const element = useRef<HTMLElement | null>(null)
  const setElement = (node: HTMLElement | null) => { element.current = node; assignRef(anchorRef, node) }
  return <Popover open={open} onOpenChange={setOpen}>
    {anchor ? <PopoverAnchor asChild ref={setElement}>{anchor}</PopoverAnchor> : children ? <PopoverTrigger asChild>{children}</PopoverTrigger> : null}
    <PopoverContent align={align} side={side} className="w-64 p-3 text-xs" onCloseAutoFocus={(event) => { if (anchor) { event.preventDefault(); element.current?.focus() } }}>
      {content}
    </PopoverContent>
  </Popover>
}

export function ConfirmPopover({ title, description, confirmLabel, cancelLabel = "Cancel", tone = "default", onConfirm, open, onOpenChange, align = "start", side = "bottom", children, anchor, ref }: PopoverShellProps & {
  onConfirm: () => void | Promise<void>
}) {
  const [isOpen, setOpen] = useOpen(open, onOpenChange)
  function confirm() {
    setOpen(false)
    void Promise.resolve().then(onConfirm)
  }
  return <Shell open={isOpen} setOpen={setOpen} anchor={anchor} anchorRef={ref} align={align} side={side} content={
    <div className="grid gap-2" onKeyDown={(event) => { if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); confirm() } }}>
      <p className="font-medium">{title}</p>
      {description && <div className="text-muted-foreground">{description}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>{cancelLabel}</Button>
        <Button type="button" size="sm" variant={tone === "destructive" ? "destructive" : "default"} autoFocus onClick={confirm}>{confirmLabel}</Button>
      </div>
    </div>
  }>{children}</Shell>
}

export function FormPopover({ title, description, confirmLabel, cancelLabel = "Cancel", tone = "default", onSubmit, canSubmit = true, open, onOpenChange, align = "start", side = "bottom", children, fields, anchor, ref }: PopoverShellProps & {
  /** The form fields. */
  fields: ReactNode
  canSubmit?: boolean
  onSubmit: () => void | Promise<void>
}) {
  const [isOpen, setOpen] = useOpen(open, onOpenChange)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const frame = requestAnimationFrame(() => form.current?.querySelector<HTMLElement>("input, textarea, select, [tabindex]:not([tabindex='-1'])")?.focus())
    return () => cancelAnimationFrame(frame)
  }, [isOpen])
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setOpen(false)
    void Promise.resolve().then(onSubmit)
  }
  return <Shell open={isOpen} setOpen={setOpen} anchor={anchor} anchorRef={ref} align={align} side={side} content={
    <form ref={form} className="grid gap-2" onSubmit={submit}>
      <p className="font-medium">{title}</p>
      {description && <div className="text-muted-foreground">{description}</div>}
      {fields}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>{cancelLabel}</Button>
        <Button type="submit" size="sm" variant={tone === "destructive" ? "destructive" : "default"} disabled={!canSubmit}>{confirmLabel}</Button>
      </div>
    </form>
  }>{children}</Shell>
}
