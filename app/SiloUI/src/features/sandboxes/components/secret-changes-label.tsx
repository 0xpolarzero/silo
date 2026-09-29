import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceState } from "@/features/application/model/application-source"

export function SecretChangesLabel({ workspace, state, secrets, inline = false }: { workspace: string; state: WorkspaceState; secrets: string[]; inline?: boolean }) {
  const stopped = state === "stopped"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="note"
          tabIndex={0}
          aria-label={stopped ? `Secret changes apply on next start for ${workspace}` : `Restart required for ${workspace}`}
          className={inline
            ? "cursor-help rounded-sm text-amber-700 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:text-amber-400"
            : "shrink-0 cursor-help rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:text-amber-400"}
        >
          {stopped ? "Applies on next start" : "Restart required"}
        </span>
      </TooltipTrigger>
      <TooltipContent className="break-words">
        {stopped ? "Start" : "Restart"} {workspace} to apply secret changes: {secrets.join(", ")}.
      </TooltipContent>
    </Tooltip>
  )
}
