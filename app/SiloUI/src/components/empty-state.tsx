import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The one empty-state style: a centered explanation in a dashed frame, with an optional
 * icon and a next step. Use it wherever a page or pane has nothing to show yet.
 */
export function EmptyState({ icon, title, description, action, className }: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div data-slot="empty-state" className={cn("grid min-h-48 place-items-center rounded-lg border border-dashed border-border px-6 py-6 text-center", className)}>
      <div className="grid justify-items-center">
        {icon && <span aria-hidden="true" className="mb-3 text-muted-foreground [&_svg]:size-5">{icon}</span>}
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  )
}
