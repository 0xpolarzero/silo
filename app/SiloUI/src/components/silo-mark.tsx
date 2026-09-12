import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/**
 * The Silo mark: two levels and one orange core, each
 * with its characteristic gap. The icon's dark plate is omitted so the glyphs
 * sit directly on the surrounding surface; the levels use currentColor (dark
 * in light mode, ivory in dark mode) while the orange core stays fixed. The
 * viewBox is tightened to the arcs' bounds.
 */
export function SiloMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg viewBox="21.5 21.5 85 85" aria-hidden="true" className={cn("shrink-0 text-foreground", className)} {...props}>
      <g fill="none" strokeWidth="7" strokeLinecap="round">
        <path d="M 60.386 102.832 A 39 39 0 1 1 98.435 82.309" stroke="currentColor" />
        <path d="M 88.625 72.344 A 26 26 0 1 1 75.804 40.834" stroke="currentColor" />
        <path d="M 72.591 54.243 A 13 13 0 1 1 52.316 58.301" stroke="#FF9F0A" />
      </g>
    </svg>
  )
}
