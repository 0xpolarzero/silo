import type { ComponentProps } from "react"
import { useEffect, useRef, useState } from "react"
import { AlertCircle, Check, Copy, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

type CopyStatus = "idle" | "copied" | "failed"

type CopyLabels = Record<CopyStatus, string>

interface CopyButtonProps extends Omit<ComponentProps<typeof Button>, "aria-label" | "children" | "value"> {
  icon?: LucideIcon
  value: string | (() => string)
  labels: CopyLabels
  text?: CopyLabels
}

export function CopyButton({ value, labels, text, icon: IdleIcon = Copy, type = "button", onClick, ...props }: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle")
  const resetTimer = useRef<number | undefined>(undefined)
  const revision = useRef(0)

  useEffect(() => () => {
    revision.current++
    window.clearTimeout(resetTimer.current)
  }, [])

  async function copy() {
    const request = ++revision.current
    window.clearTimeout(resetTimer.current)
    let next: CopyStatus
    try {
      await navigator.clipboard.writeText(typeof value === "function" ? value() : value)
      next = "copied"
    } catch {
      next = "failed"
    }
    if (request !== revision.current) return
    setStatus(next)
    resetTimer.current = window.setTimeout(() => setStatus("idle"), 1_200)
  }

  const Icon = status === "copied" ? Check : status === "failed" ? AlertCircle : IdleIcon

  return (
    <Button
      {...props}
      type={type}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) void copy()
      }}
      aria-label={labels[status]}
      aria-live="polite"
      aria-atomic="true"
      data-copy-status={status}
    >
      <Icon data-icon={text ? "inline-start" : undefined} aria-hidden="true" />
      {text?.[status]}
    </Button>
  )
}
