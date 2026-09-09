import { Code } from "lucide-react"
import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export function FolderActions({ path, onOpen, disabled = false }: { path: string; onOpen: () => void; disabled?: boolean }) {
  return <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 [@media(hover:none)]:opacity-100">
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Open in code editor" disabled={disabled} onClick={onOpen}><Code /></Button></TooltipTrigger>
        <TooltipContent>Open in code editor</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild><CopyButton variant="ghost" size="icon-xs" value={path} labels={{ idle: "Copy path", copied: "Path copied", failed: "Could not copy path" }} /></TooltipTrigger>
        <TooltipContent>Copy path</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
}
