import { createContext, useContext } from "react"

/**
 * The surface's reduced-motion preference. `TooltipProvider` supplies it (see UI-PATTERNS.md,
 * Tooltips); React context crosses portals, so popovers, selects and menus rendered on
 * `<body>`, outside `.silo-window`, read it here. They carry the `silo-portal` class and
 * `data-reduce-motion`, and `index.css` disables their animations and transitions for that
 * attribute and for the system's `prefers-reduced-motion` setting.
 */
export const ReduceMotionContext = createContext(false)

export function useReduceMotion() {
  return useContext(ReduceMotionContext)
}
