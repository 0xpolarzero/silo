import { Network } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceComputer } from "@/features/application/model/remote-computers"

export function ComputerBadge({ computer }: { computer: WorkspaceComputer }) {
  const detail = `${computer.name} · ${computer.busy ? "Applying VM changes" : computer.connected ? "Connected" : "Unavailable"} · ${computer.address}${!computer.connected && computer.lastSeen ? ` · Last seen ${new Date(computer.lastSeen).toLocaleString()}` : ""}`
  return <TooltipProvider><Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label={`Remote VM on ${detail}`} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-300"><Network aria-hidden="true" className="size-2.5" />VM</span></TooltipTrigger><TooltipContent>{detail}</TooltipContent></Tooltip></TooltipProvider>
}
