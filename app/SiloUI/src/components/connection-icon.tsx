import { Monitor, Network, Server } from "lucide-react"
import { cn } from "@/lib/utils"

/** Connection type stays recognizable; the corner marker adds network scope. */
export function ConnectionIcon({ kind, network = false, label, className }: {
  kind: "vm" | "ssh"
  network?: boolean
  label?: string
  className?: string
}) {
  const Icon = kind === "vm" ? Monitor : Server
  return <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("relative inline-flex size-4 shrink-0", className)}>
    <Icon className="size-full" aria-hidden="true" />
    {network && <span className="absolute -top-0.5 -right-0.5 grid size-2.5 place-items-center rounded-full bg-background" aria-hidden="true">
      <Network strokeWidth={3} className="size-2" />
    </span>}
  </span>
}
