import { Monitor, Network, Server } from "lucide-react"
import { cn } from "@/lib/utils"

/** Use one silhouette for each connection context, without layered markers. */
export function ConnectionIcon({ kind, network = false, label, className }: {
  kind: "vm" | "ssh"
  network?: boolean
  label?: string
  className?: string
}) {
  const Icon = kind === "vm" ? (network ? Server : Monitor) : (network ? Network : Server)
  return <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("relative inline-flex size-4 shrink-0", className)}>
    <Icon className="size-full" aria-hidden="true" />

  </span>
}
