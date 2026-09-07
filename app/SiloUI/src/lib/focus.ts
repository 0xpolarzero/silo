const restoringFocus = new WeakSet<HTMLElement>()

export function restoreFocus(element: HTMLElement | null) {
  if (!element) return
  restoringFocus.add(element)
  try {
    element.focus()
  } finally {
    restoringFocus.delete(element)
  }
}

export function isRestoringFocus(element: HTMLElement) {
  return restoringFocus.has(element)
}
