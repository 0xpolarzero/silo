import type { ComponentProps, ReactNode } from "react"

import { cn } from "@/lib/utils"

export function ListCard({ divided = false, className, ...props }: ComponentProps<"div"> & { divided?: boolean }) {
  // Divide peer rows only; expanded details provide their own inset border.
  return <div className={cn("overflow-hidden rounded-md border border-border", divided && "divide-y divide-border", className)} {...props} />
}

export function ListRowDetails({ label, className, ...props }: { label: string } & ComponentProps<"div">) {
  return <div role="group" aria-label={label} className={cn("mx-2 grid gap-3 border-t border-border py-3 pr-1 pl-8 text-xs", className)} {...props} />
}

export function ListRow({
  icon,
  title,
  detail,
  leading,
  actions,
  detailClassName,
  onOpen,
  openLabel,
  className,
  ...props
}: {
  icon: ReactNode
  title: ReactNode
  detail: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  detailClassName?: string
  /** Makes the row body (title and detail) a button that opens the row's own view. */
  onOpen?: () => void
  openLabel?: string
} & Omit<ComponentProps<"div">, "title" | "children">) {
  const content = (
    <>
      <div data-slot="list-row-title" className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4 font-medium">{title}</div>
      <div className={cn("truncate text-[11px] leading-4 text-muted-foreground", detailClassName)}>{detail}</div>
    </>
  )
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 px-2 py-2 transition-colors", className)} {...props}>
      {leading}
      {icon}
      {onOpen ? (
        <div
          data-slot="list-row-content"
          role="button"
          tabIndex={0}
          aria-label={openLabel}
          className="min-w-0 flex-1 cursor-pointer text-left outline-none rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onOpen}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen() } }}
        >
          {content}
        </div>
      ) : (
        <div data-slot="list-row-content" className="min-w-0 flex-1">{content}</div>
      )}
      {actions}
    </div>
  )
}

export function ListRowIcon({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground", className)} {...props} />
}
