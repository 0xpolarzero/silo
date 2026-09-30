import type { ReactElement } from "react"

import { ConfirmPopover } from "@/components/confirm-popover"
import type { ApplicationWorkspace } from "@/features/application/model/application-source"
import type { LifecycleAction, LifecycleGuard } from "@/features/application/model/lifecycle-guard"
import { DisabledReason } from "./disabled-reason"

/**
 * A Start, Stop or Restart control routed through the shared lifecycle guard. When the
 * request needs a prompt (memory pressure, or interrupting a running sandbox) the prompt
 * opens in a popover anchored to the control itself, so it appears where the user clicked.
 * A disabled control says why.
 */
export function LifecycleControl({ guard, workspace, action, disabled = false, reason, align = "end", open, onOpenChange, children }: {
  guard: LifecycleGuard
  workspace: ApplicationWorkspace
  action: LifecycleAction
  disabled?: boolean
  reason?: string
  align?: "start" | "center" | "end"
  /** Opens the prompt without a click (a palette or menu request for this control). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The trigger. `onClick` is set when the request runs without a prompt. */
  children: (props: { onClick?: () => void; disabled: boolean }) => ReactElement
}) {
  if (disabled) return <DisabledReason reason={reason}>{children({ disabled: true })}</DisabledReason>
  const check = guard.check(workspace, action)
  if (check.kind !== "confirm") return children({ disabled: false, onClick: () => guard.request(workspace, action) })
  const { prompt } = check
  return <ConfirmPopover align={align} tone={prompt.tone} title={prompt.title} description={prompt.description} confirmLabel={prompt.confirmLabel} open={open} onOpenChange={onOpenChange} onConfirm={() => guard.confirm(workspace, action)}>
    {children({ disabled: false })}
  </ConfirmPopover>
}
