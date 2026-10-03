import { useEffect, useRef, type ReactNode } from "react"

const activeConfirmations: symbol[] = []

function removeConfirmation(id: symbol) {
  const index = activeConfirmations.lastIndexOf(id)
  if (index >= 0) activeConfirmations.splice(index, 1)
}

export function InlineConfirmation({ active, onDismiss, children }: {
  active: boolean
  onDismiss: () => void
  children: ReactNode
}) {
  const boundary = useRef<HTMLSpanElement>(null)
  const id = useRef(Symbol("inline-confirmation"))
  const dismiss = useRef(onDismiss)

  useEffect(() => {
    dismiss.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!active) return
    const confirmationID = id.current
    activeConfirmations.push(confirmationID)

    function isTopmost() {
      return activeConfirmations.at(-1) === confirmationID
    }

    function dismissOutside(event: PointerEvent) {
      if (!isTopmost()) return
      const target = event.target
      if (target instanceof Node && boundary.current?.contains(target)) return
      dismiss.current()
    }

    function inForeignDialog(target: EventTarget | null) {
      const dialog = target instanceof Element ? target.closest('[role="dialog"], [role="alertdialog"]') : null
      return dialog !== null && !dialog.contains(boundary.current) && !boundary.current?.contains(dialog)
    }

    function dismissOnEscape(event: KeyboardEvent) {
      if (inForeignDialog(event.target)) return
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && isTopmost()) {
        event.preventDefault()
        dismiss.current()
      }
    }

    document.addEventListener("pointerdown", dismissOutside, true)
    document.addEventListener("keydown", dismissOnEscape, true)
    return () => {
      removeConfirmation(confirmationID)
      document.removeEventListener("pointerdown", dismissOutside, true)
      document.removeEventListener("keydown", dismissOnEscape, true)
    }
  }, [active])

  return <span ref={boundary} className="contents" data-inline-confirmation="">{children}</span>
}
